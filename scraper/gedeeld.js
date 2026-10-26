// gedeeld.js
//
// Scrapecode die zowel de pitchmachine (index.js) als de nieuwsdienst
// (zanp.js) gebruikt. ZANP-fase 2 (2026-10-24).
//
// Dit zijn de functies uit index.js, LETTERLIJK verplaatst. De enige
// aanpassing: scrapeAlleBronnen krijgt een optionele lijst bronnen, zodat
// zanp.js per run maar een deel van de bronnen kan scrapen. Zonder argument
// doet hij precies wat hij altijd deed.
//
// Let op: de status "afgeleideAgenda" (een bron die niet als agenda staat
// maar zich wel zo gedraagt) en de filterTermen van bronnen (bijvoorbeeld
// rechtspraak) zitten in deze functies. Daarom is verplaatsen veiliger dan
// herschrijven.
//
// Sinds 2026-10-26:
//  - Parallel scrapen (4 tegelijk) met time-out van 45s.
//  - effectieveBron retourneert nu altijd een kopie, om mutatie van de
//    originele bronnenlijst te voorkomen.

const fs = require("fs/promises");
const path = require("path");

const bronnen = require("./bronnen");
const { scraperVoorType } = require("./scraper-register");
const {
  oorzaakTekst,
  agendaUitDatums,
  kalenderdagAmsterdam,
  vandaagAmsterdam,
} = require("./hulpmiddelen");

const DATA_MAP = path.join(__dirname, "..", "data");

const GEEN_TEKSTOPHAAL_TYPES = new Set(["ibabs"]);
const GEEN_TEKSTOPHAAL_BRONNEN = new Set(["OmgevingsdienstNHN"]);
const PAGINADATUM_TYPES = new Set(["gemini-recept", "generieke-lijst", "wordpress-html", "json-ld"]);
const afgeleideAgenda = new Map();

function effectieveBron(bron) {
  if (afgeleideAgenda.has(bron.id)) return { ...bron, soort: "agenda" };
  return { ...bron };
}

function isAgendaItem(b) {
  const bron = bronnen.find((x) => x.id === b.bronId);
  return Boolean(bron && (bron.soort === "agenda" || afgeleideAgenda.has(bron.id)));
}

function logFase(titel) {
  console.log(`\n=== ${titel} — ${new Date().toISOString()} ===`);
}

function logDuur(startMs, label) {
  const duurSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`${label} klaar in ${duurSec}s`);
}

async function metTijdslimiet(belofte, ms, melding) {
  if (!ms || ms <= 0) return belofte;
  let timer;
  const limiet = new Promise((_, afwijzen) => {
    timer = setTimeout(() => afwijzen(new Error(melding)), ms);
  });
  return Promise.race([belofte, limiet]).finally(() => clearTimeout(timer));
}

async function scrapeAlleBronnen(bronnenLijst = bronnen, opties = {}) {
  const alleBerichten = [];
  const parallel = Math.max(1, opties.parallel || 1);
  const timeoutMs = opties.timeoutMs || 0; // 0 = geen timeout (pitchrun)

  const wachtrij = [...bronnenLijst].map((bron, index) => ({ bron, index }));
  const resultaten = new Map(); // index -> berichten

  async function verwerkBron({ bron, index }) {
    const scraper = scraperVoorType(bron.type);
    if (!scraper) {
      console.warn(`[${bron.id}] Onbekend brontype "${bron.type}" — overgeslagen.`);
      return;
    }

    const startBron = Date.now();
    try {
      let berichten = await metTijdslimiet(
        scraper(bron),
        timeoutMs,
        `time-out na ${(timeoutMs / 1000).toFixed(1)}s bij ${bron.id}`
      );

      if (bron.filterTermen && bron.filterTermen.length > 0) {
        const voorFilter = berichten.length;
        const termen = bron.filterTermen.map((t) => String(t).toLowerCase());
        berichten = berichten.filter((b) => {
          const hooiberg = `${b.titel || ""} ${b.samenvatting || ""}`.toLowerCase();
          return termen.some((term) => hooiberg.includes(term));
        });
        const weg = voorFilter - berichten.length;
        if (weg > 0) {
          console.log(`[${bron.id}] ${weg} van ${voorFilter} bericht(en) weggefilterd (geen filterTerm in titel of samenvatting).`);
        }
      }

      const duurSec = ((Date.now() - startBron) / 1000).toFixed(1);
      console.log(`[${bron.id}] ${berichten.length} bericht(en) gevonden (${duurSec}s).`);

      if (bron.soort !== "agenda" && PAGINADATUM_TYPES.has(bron.type)) {
        const afleiding = agendaUitDatums(berichten);
        if (afleiding.lijktOpAgenda) {
          const melding = `Bron "${bron.id}" staat niet als agenda in bronnen.js, maar ${afleiding.reden}. Voor deze run is hij als agenda behandeld. Zet bij deze bron in bronnen.js de regel soort: 'agenda', (of voeg hem opnieuw toe via "Bron toevoegen").`;
          afgeleideAgenda.set(bron.id, melding);
          console.warn(`[${bron.id}] ⚠️  ${melding}`);
        }
      }
      resultaten.set(index, berichten);
    } catch (fout) {
      const duurSec = ((Date.now() - startBron) / 1000).toFixed(1);
      console.error(`[${bron.id}] Scrapen mislukt na ${duurSec}s: ${fout.message}${oorzaakTekst(fout)}`);
      resultaten.set(index, []);
    }
  }

  if (parallel === 1) {
    for (const item of wachtrij) {
      await verwerkBron(item);
    }
  } else {
    const actieve = new Set();
    while (wachtrij.length > 0 || actieve.size > 0) {
      while (wachtrij.length > 0 && actieve.size < parallel) {
        const item = wachtrij.shift();
        const belofte = verwerkBron(item).finally(() => actieve.delete(belofte));
        actieve.add(belofte);
      }
      if (actieve.size > 0) {
        await Promise.race(actieve);
      }
    }
  }

  // Zet de berichten in de oorspronkelijke volgorde van bronnenLijst.
  for (let i = 0; i < bronnenLijst.length; i++) {
    if (resultaten.has(i)) {
      alleBerichten.push(...resultaten.get(i));
    }
  }

  return alleBerichten;
}

function verwijderDubbelen(berichten) {
  const gezieneUrls = new Set();
  return berichten.filter((b) => {
    if (!b.url || gezieneUrls.has(b.url)) return false;
    gezieneUrls.add(b.url);
    return true;
  });
}

async function schrijfJson(bestandsnaam, data) {
  await fs.mkdir(DATA_MAP, { recursive: true });
  await fs.writeFile(path.join(DATA_MAP, bestandsnaam), JSON.stringify(data, null, 2), "utf-8");
}

async function leesJson(bestandsnaam, standaard) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_MAP, bestandsnaam), "utf-8"));
  } catch {
    return standaard;
  }
}

function nietInToekomst(iso) {
  if (!iso) return false;
  const dag = kalenderdagAmsterdam(iso);
  if (!dag) return false;
  return dag <= vandaagAmsterdam();
}

module.exports = {
  DATA_MAP,
  GEEN_TEKSTOPHAAL_TYPES,
  GEEN_TEKSTOPHAAL_BRONNEN,
  PAGINADATUM_TYPES,
  afgeleideAgenda,
  effectieveBron,
  isAgendaItem,
  logFase,
  logDuur,
  scrapeAlleBronnen,
  verwijderDubbelen,
  schrijfJson,
  leesJson,
  nietInToekomst,
};
