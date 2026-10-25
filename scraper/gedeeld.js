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
  return afgeleideAgenda.has(bron.id) ? { ...bron, soort: "agenda" } : bron;
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

async function scrapeAlleBronnen(bronnenLijst = bronnen) {
  const alleBerichten = [];

  for (const bron of bronnenLijst) {
    const scraper = scraperVoorType(bron.type);
    if (!scraper) {
      console.warn(`[${bron.id}] Onbekend brontype "${bron.type}" — overgeslagen.`);
      continue;
    }

    const startBron = Date.now();
    try {
      let berichten = await scraper(bron);

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
      alleBerichten.push(...berichten);
    } catch (fout) {
      const duurSec = ((Date.now() - startBron) / 1000).toFixed(1);
      console.error(`[${bron.id}] Scrapen mislukt na ${duurSec}s: ${fout.message}${oorzaakTekst(fout)}`);
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
