// index.js — hoofdscript van de dagelijkse run
//
// Sinds de "pitch-en-filter-uit-elkaar"-ronde (2026-10-22):
//  - Nieuws gaat NIET meer door het criteria-filter. Elk nieuwsbericht
//    binnen het datumvenster gaat direct naar de pitch-call (afspraak 1).
//  - Agenda doorloopt nog steeds het criteria-filter (afspraak 2).
//  - Pitch is kort: vier velden (afspraak 3 en 4).
//  - Top-pitches worden op datum gesorteerd (afspraak 5).
//  - Feed-berichten die al in feed.json staan maar binnen het pitch-venster
//    vallen, worden opnieuw verrijkt (afspraak 7).
//
// Ongewijzigd voor agenda sinds 2026-10-21: filter met scores 0-3,
// citaat-controle, wegingen, drempel.
//
// Sinds de ZANP-ronde (2026-10-23): de nieuwsdienst-laag erbij. Pitch,
// filter en feed werken ongewijzigd door; er komen twee databestanden bij.
//  - STAP 4b bouwt data/agenda.json uit ALLE agenda-items (ook de komende
//    drie weken), zonder AI. Dit staat los van het nieuwsvenster: de feed
//    houdt toekomstige items bewust buiten beeld, een weekagenda niet.
//  - STAP 6b bouwt data/berichten.json: de stroom met kop, korte tekst,
//    rubriek, prio en versies. Draait ook zonder API-sleutel (dan alleen
//    originele koppen). De AI-tekst gaat door een cijfercontrole (wire.js)
//    en wordt alleen gemaakt voor bronnen met herschrijf: true in
//    rubrieken.js. Artikelen van andere redacties blijven kop + link.

const fs = require("fs/promises");
const path = require("path");

const bronnen = require("./bronnen");
const { scraperVoorType } = require("./scraper-register");
const {
  beoordeelBerichten,
  genereerPitches,
  schrijfMeldingen,
  PROMPT_VERSIE,
  PROMPT_VERSIE_WIRE,
  MODELLEN,
} = require("./gemini");
const { DREMPEL, MAX_SCORE_LOKAAL, MAX_SCORE_LANDELIJK } = require("./nieuwscriteria");
const { RUBRIEKEN, isBekendeBron } = require("./rubrieken");
const { bouwAgenda, planBerichten, verwerkMelding, voegBerichtenSamen, MIN_TEKST_VOOR_AI } = require("./wire");
const {
  binnenVenster,
  MAX_LEEFTIJD_DAGEN,
  oorzaakTekst,
  vulBerichtenAanMetTekst,
  tekstStatistiekRegel,
  agendaUitDatums,
  kalenderdagAmsterdam,
  vandaagAmsterdam,
  dagVerschil,
} = require("./hulpmiddelen");

const DATA_MAP = path.join(__dirname, "..", "data");
const DAGCAP_GEMINI = Number(process.env.DAGCAP_GEMINI || 100);
const AANTAL_PITCHES = Number(process.env.AANTAL_PITCHES || 10);
const FEED_MAX_ITEMS = Number(process.env.FEED_MAX_ITEMS || 800);
const FEED_SAMENVATTING_TEKENS = Number(process.env.FEED_SAMENVATTING_TEKENS || 250);
// Aparte dagcap voor de meldingen van de nieuwsdienst; deze komen boven op
// de pitch-aanroepen. Houd de dagelijkse quotum van het gratis Gemini-model
// in de gaten als je beide hoog zet.
const WIRE_CAP = Number(process.env.WIRE_CAP || 80);

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

function telPerBron(ruweBerichten, recenteBerichten) {
  const gevondenPerBron = {};
  const overPerBron = {};
  for (const b of ruweBerichten) gevondenPerBron[b.bronId] = (gevondenPerBron[b.bronId] || 0) + 1;
  for (const b of recenteBerichten) overPerBron[b.bronId] = (overPerBron[b.bronId] || 0) + 1;
  return { gevondenPerBron, overPerBron };
}

function beschrijfDatum(iso) {
  if (!iso) return "geen datum";
  const dag = kalenderdagAmsterdam(iso);
  if (!dag) return "ongeldige datum";
  const verschil = dagVerschil(dag, vandaagAmsterdam());
  if (verschil === null) return dag;
  if (verschil === 0) return `${dag} (vandaag)`;
  if (verschil === 1) return `${dag} (gisteren)`;
  if (verschil === -1) return `${dag} (morgen)`;
  if (verschil > 0) return `${dag} (${verschil} dagen oud)`;
  return `${dag} (over ${-verschil} dagen)`;
}

function kortTitel(titel) {
  const t = (titel || "(geen titel)").replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

function logBronOverzicht({ gevondenPerBron, overPerBron, ruweBerichten = [] }) {
  const perBron = new Map();
  for (const b of ruweBerichten) {
    if (!perBron.has(b.bronId)) perBron.set(b.bronId, []);
    perBron.get(b.bronId).push(b);
  }

  console.log("\n--- Bronoverzicht (gevonden → binnen pitch-venster) ---");
  for (const bronConfig of bronnen) {
    const bron = effectieveBron(bronConfig);
    const gevonden = gevondenPerBron[bron.id] || 0;
    const over = overPerBron[bron.id] || 0;

    let status;
    if (gevonden === 0 && bron.type === "ibabs") {
      status = "ℹ️  geen berichten binnen 1 dag (iBabs filtert zelf op datum)";
    } else if (gevonden === 0) {
      status = "❌ GEEN BERICHTEN GEVONDEN — scraper/selector waarschijnlijk kapot";
    } else if (over === 0 && bron.rustig) {
      status = "💤 rustige bron, nu geen recente berichten (verwacht)";
    } else if (over === 0 && bron.soort === "agenda") {
      const berichten = perBron.get(bron.id) || [];
      const heeftLeesbareDatums = berichten.some(
        (b) => b.gepubliceerdOp && !isNaN(new Date(b.gepubliceerdOp).getTime())
      );
      if (heeftLeesbareDatums) {
        status = "ℹ️  geen evenement vandaag — komt wel in de feed";
      } else {
        status = "⚠️  0 binnen het agenda-venster — geen enkele leesbare datum in de lijst (datumherkenning controleren)";
      }
    } else if (over === 0) {
      status = "ℹ️  0 binnen het pitch-venster — komt wel in de feed";
    } else {
      status = "✅ OK";
    }

    const soort = bron.soort === "agenda" ? (afgeleideAgenda.has(bron.id) ? " [agenda!]" : " [agenda]") : "";
    console.log(`  ${(bron.id + soort).padEnd(28)} ${String(gevonden).padStart(3)} → ${String(over).padStart(3)}   ${status}`);

    if (over === 0 && gevonden > 0 && !bron.rustig) {
      const berichten = perBron.get(bron.id) || [];
      let recentste = null;
      let recentsteTijd = -Infinity;
      let aantalZonderDatum = 0;
      for (const b of berichten) {
        if (!b.gepubliceerdOp) {
          aantalZonderDatum++;
          continue;
        }
        const t = new Date(b.gepubliceerdOp).getTime();
        if (!isNaN(t) && t > recentsteTijd) {
          recentsteTijd = t;
          recentste = b;
        }
      }
      if (recentste) {
        console.log(`      meest recent: ${beschrijfDatum(recentste.gepubliceerdOp)} — "${kortTitel(recentste.titel)}"`);
      } else {
        console.log(`      geen enkel bericht heeft een leesbare datum`);
      }
      if (aantalZonderDatum > 0) {
        console.log(`      ${aantalZonderDatum} van de ${gevonden} berichten zonder leesbare datum (tellen niet mee)`);
      }
    }
  }
  console.log("---\n");
}

const GEZONDHEID_BESTAND = path.join(DATA_MAP, "bron-gezondheid.json");

function kalenderdag(iso) {
  return kalenderdagAmsterdam(iso);
}

async function werkBronGezondheidBij({ gevondenPerBron, overPerBron }) {
  let vorige = {};
  try {
    vorige = JSON.parse(await fs.readFile(GEZONDHEID_BESTAND, "utf-8"));
  } catch {
    // eerste run
  }

  const vandaag = kalenderdag(new Date().toISOString());

  function volgendeTeller(huidigAantal, eerder) {
    if (huidigAantal > 0) return 0;
    const vorigeTeller = (eerder && eerder.teller) || 0;
    const vorigeDag = eerder && eerder.dag;
    if (vorigeDag === vandaag) return vorigeTeller;
    return vorigeTeller + 1;
  }

  const nieuw = {};
  for (const bron of bronnen) {
    const gevonden = gevondenPerBron[bron.id] || 0;
    const binnenVensterAantal = overPerBron[bron.id] || 0;
    const eerder = vorige[bron.id];
    const eerderBerichten = eerder && { teller: eerder.opeenvolgendGeenBerichten, dag: kalenderdag(eerder.laatsteRun) };
    const eerderVenster = eerder && { teller: eerder.opeenvolgendGeenBinnenVenster, dag: kalenderdag(eerder.laatsteRun) };
    nieuw[bron.id] = {
      laatsteRun: new Date().toISOString(),
      gevonden,
      binnenVenster: binnenVensterAantal,
      opeenvolgendGeenBerichten: volgendeTeller(gevonden, eerderBerichten),
      opeenvolgendGeenBinnenVenster: volgendeTeller(binnenVensterAantal, eerderVenster),
    };
  }
  await schrijfJson("bron-gezondheid.json", nieuw);
}

async function scrapeAlleBronnen() {
  const alleBerichten = [];

  for (const bron of bronnen) {
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

function kortAfTekst(tekst, max) {
  const t = (tekst || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const stuk = t.slice(0, max);
  const laatsteSpatie = stuk.lastIndexOf(" ");
  return `${(laatsteSpatie > max - 40 ? stuk.slice(0, laatsteSpatie) : stuk).trim()}…`;
}

function nietInToekomst(iso) {
  if (!iso) return false;
  const dag = kalenderdagAmsterdam(iso);
  if (!dag) return false;
  return dag <= vandaagAmsterdam();
}

async function leesFeedUrls() {
  try {
    const inhoud = JSON.parse(await fs.readFile(path.join(DATA_MAP, "feed.json"), "utf-8"));
    if (!Array.isArray(inhoud)) return new Set();
    return new Set(inhoud.map((b) => b.url).filter(Boolean));
  } catch {
    return new Set();
  }
}

const FEED_BRON_ALIASSEN = {
  "zaans-cultuur-huis": "Zaans Cultuurhuis — Agenda",
  "zaanstad-hoorzittingen": "Zaanstad — Hoorzittingen",
  hhnk: "Hoogheemraadschap Hollands Noorderkwartier — Nieuws",
  "zaandijk-leeft": "Zaandijk Leeft!",
  OmgevingsdienstNHN: "Omgevingsdienst Noord-Holland Noord",
  omgevingsdienstnoordzeekanaal: "Omgevingsdienst Noordzeekanaalgebied",
  WaarheenAgenda: "Waarheen Agenda (De Orkaan)",
};

function maakBronLookup(bronPerId) {
  const perId = new Map();
  const perNaam = new Map();
  for (const bron of Object.values(bronPerId)) {
    perId.set(bron.id, bron);
    perNaam.set(bron.naam, bron);
  }
  return { perId, perNaam };
}

function vindBronVoorItem(item, lookup) {
  if (item.bronId && lookup.perId.has(item.bronId)) return lookup.perId.get(item.bronId);
  if (item.bronNaam && lookup.perNaam.has(item.bronNaam)) return lookup.perNaam.get(item.bronNaam);
  const alias = item.bronNaam ? FEED_BRON_ALIASSEN[item.bronNaam] : null;
  if (alias && lookup.perNaam.has(alias)) return lookup.perNaam.get(alias);
  return null;
}

async function werkFeedBij(berichten, bronPerId) {
  const feedPad = path.join(DATA_MAP, "feed.json");
  const lookup = maakBronLookup(bronPerId);

  let bestaand = [];
  try {
    const inhoud = JSON.parse(await fs.readFile(feedPad, "utf-8"));
    if (Array.isArray(inhoud)) bestaand = inhoud;
  } catch {
    // eerste run
  }

  let soortGecorrigeerd = 0;
  let idBijgeplakt = 0;
  let naamGecorrigeerd = 0;
  bestaand = bestaand.map((item) => {
    const bron = vindBronVoorItem(item, lookup);
    if (!bron) return item;

    const nieuweSoort = bron.soort === "agenda" ? "agenda" : "nieuws";
    const wijzigingen = {};
    if (item.soort !== nieuweSoort) {
      wijzigingen.soort = nieuweSoort;
      soortGecorrigeerd++;
    }
    if (!item.bronId) {
      wijzigingen.bronId = bron.id;
      idBijgeplakt++;
    }
    if (item.bronNaam !== bron.naam) {
      wijzigingen.bronNaam = bron.naam;
      naamGecorrigeerd++;
    }
    return Object.keys(wijzigingen).length === 0 ? item : { ...item, ...wijzigingen };
  });

  const voorToekomst = bestaand.length;
  bestaand = bestaand.filter((b) => nietInToekomst(b.gepubliceerdOp));
  const uitToekomst = voorToekomst - bestaand.length;

  const bestaandeUrls = new Set(bestaand.map((b) => b.url).filter(Boolean));
  const nieuw = [];
  const overgeslagen = { buitenVenster: 0 };
  for (const b of berichten) {
    if (!b.url || bestaandeUrls.has(b.url)) continue;
    if (!nietInToekomst(b.gepubliceerdOp)) {
      overgeslagen.buitenVenster++;
      continue;
    }
    const bron = bronPerId[b.bronId];
    nieuw.push({
      url: b.url,
      titel: b.titel,
      samenvatting: kortAfTekst(b.samenvatting || "", FEED_SAMENVATTING_TEKENS),
      foto: b.foto || null,
      gepubliceerdOp: b.gepubliceerdOp,
      bronId: b.bronId,
      bronNaam: b.bronNaam,
      categorie: b.categorie,
      soort: bron && bron.soort === "agenda" ? "agenda" : "nieuws",
    });
    bestaandeUrls.add(b.url);
  }

  const samen = [...nieuw, ...bestaand];
  samen.sort((a, b) => {
    const ta = new Date(a.gepubliceerdOp).getTime();
    const tb = new Date(b.gepubliceerdOp).getTime();
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return tb - ta;
  });
  const gecapt = FEED_MAX_ITEMS > 0 ? samen.slice(0, FEED_MAX_ITEMS) : samen;
  const verwijderd = samen.length - gecapt.length;
  const metFoto = gecapt.filter((b) => b.foto).length;

  await schrijfJson("feed.json", gecapt);
  console.log(
    `Feed bijgewerkt: ${nieuw.length} nieuw, `
      + `${uitToekomst > 0 ? `${uitToekomst} uit de toekomst gefilterd, ` : ""}`
      + `${overgeslagen.buitenVenster > 0 ? `${overgeslagen.buitenVenster} in de toekomst overgeslagen, ` : ""}`
      + `${gecapt.length} in de feed`
      + `${verwijderd > 0 ? `, ${verwijderd} oudste verwijderd (cap = ${FEED_MAX_ITEMS})` : ""}`
      + `, ${metFoto} met foto.`
  );
  if (soortGecorrigeerd > 0) console.log(`  waarvan ${soortGecorrigeerd} bestaand(e) item(s) met een gecorrigeerde soort-vlag.`);
  if (idBijgeplakt > 0) console.log(`  ${idBijgeplakt} bestaand(e) item(s) kregen een bronId.`);
  if (naamGecorrigeerd > 0) console.log(`  ${naamGecorrigeerd} bestaand(e) item(s) kregen de huidige bronNaam.`);
}

function scoreVan(bericht) {
  const score = bericht.aiBeoordeling && bericht.aiBeoordeling.score;
  return typeof score === "number" ? score : 0;
}

function sorteerOpDatum(berichten, bronPerId) {
  const isAgenda = (b) => bronPerId[b.bronId] && bronPerId[b.bronId].soort === "agenda";
  const nieuws = berichten.filter((b) => !isAgenda(b));
  const agenda = berichten.filter((b) => isAgenda(b));
  const nu = Date.now();

  const sorteerNieuws = (lijst) =>
    lijst.slice().sort((a, b) => {
      const ta = new Date(a.gepubliceerdOp).getTime();
      const tb = new Date(b.gepubliceerdOp).getTime();
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return tb - ta;
    });

  const sorteerAgenda = (lijst) =>
    lijst.slice().sort((a, b) => {
      const ta = new Date(a.gepubliceerdOp).getTime();
      const tb = new Date(b.gepubliceerdOp).getTime();
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return Math.abs(ta - nu) - Math.abs(tb - nu);
    });

  return [...sorteerNieuws(nieuws), ...sorteerAgenda(agenda)];
}

/**
 * Afspraak 5: top-pitches op datum (nieuwste eerst), niet meer op codescore.
 * Alleen berichten met een echte pitch (werktitel én vraag) komen in de top.
 */
function stelPitchesSamen(allePitches, aantal) {
  return allePitches
    .filter((b) => b.aiBeoordeling && b.aiBeoordeling.werktitel && b.aiBeoordeling.vraag)
    .sort((a, b) => {
      const ta = new Date(a.gepubliceerdOp).getTime();
      const tb = new Date(b.gepubliceerdOp).getTime();
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return tb - ta;
    })
    .slice(0, aantal);
}

function schrijfBijdrageTabel({ gevondenPerBron, overPerBron, kansrijkPerBron }) {
  const pad = process.env.GITHUB_STEP_SUMMARY;
  if (!pad) return;
  const regels = [
    "### Bijdrage per bron",
    "",
    "| Bron | Gevonden | Binnen venster | Pitch |",
    "|------|----------|----------------|-------|",
  ];
  for (const bron of bronnen) {
    const g = gevondenPerBron[bron.id] || 0;
    const o = overPerBron[bron.id] || 0;
    const k = kansrijkPerBron[bron.id] || 0;
    regels.push(`| ${bron.id} | ${g} | ${o} | ${k} |`);
  }
  try {
    require("fs").appendFileSync(pad, `${regels.join("\n")}\n`);
  } catch {
    // samenvatting is een extraatje
  }
}

async function main() {
  const startRun = Date.now();
  console.log(`Start dagelijkse run: ${new Date().toISOString()}`);
  console.log(`Instellingen: dagcap=${DAGCAP_GEMINI}/lijst, pitches=${AANTAL_PITCHES}, feedcap=${FEED_MAX_ITEMS}`);
  console.log(`Promptversie: ${PROMPT_VERSIE}`);
  console.log(`Modellen: filter=${MODELLEN.filter[0]}, pitch=${MODELLEN.pitch[0]}, sterker=${MODELLEN.sterker[0]}`);
  console.log(`Drempels (alleen agenda): lokaal=${DREMPEL.lokaal}/${MAX_SCORE_LOKAAL}, landelijk=${DREMPEL.landelijk}/${MAX_SCORE_LANDELIJK}`);
  console.log(`Tijdzone: ${process.env.TZ || "(systeemstandaard)"} → lokale tijd ${new Date().toLocaleString("nl-NL")}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "GEMINI_API_KEY is niet gezet — het scrapen en sorteren draaien gewoon door, "
        + "maar er worden geen pitches gegenereerd en geen agenda-filters uitgevoerd."
    );
  }

  logFase("STAP 1 — Scrapen");
  const startScrapen = Date.now();
  const ruweBerichten = await scrapeAlleBronnen();
  logDuur(startScrapen, `Scrapen van ${bronnen.length} bronnen`);
  console.log(`Ruw aantal berichten (vóór ontdubbeling): ${ruweBerichten.length}`);

  const bronPerId = Object.fromEntries(bronnen.map((b) => [b.id, effectieveBron(b)]));
  const binnen = (b) => binnenVenster(b.gepubliceerdOp, bronPerId[b.bronId], b.eindDatum);

  const recenteBerichten = ruweBerichten.filter(binnen);
  const perBronZonderDatum = {};
  for (const b of ruweBerichten) {
    if (!binnen(b)) {
      perBronZonderDatum[b.bronId] = (perBronZonderDatum[b.bronId] || 0) + 1;
    }
  }
  console.log(
    `Binnen het pitch-venster (max ${MAX_LEEFTIJD_DAGEN} kalenderdag(en); agenda-bronnen: alleen vandaag): ${recenteBerichten.length} van ${ruweBerichten.length} berichten.`
  );
  for (const [bronId, aantal] of Object.entries(perBronZonderDatum)) {
    console.warn(`[${bronId}] ${aantal} bericht(en) buiten het pitch-venster (blijven wel in de feed staan).`);
  }
  const tellingen = telPerBron(ruweBerichten, recenteBerichten);
  logBronOverzicht({ ...tellingen, ruweBerichten });
  await werkBronGezondheidBij(tellingen);

  const alleBerichten = verwijderDubbelen(ruweBerichten);
  console.log(`Totaal aantal unieke berichten: ${alleBerichten.length}`);

  logFase("STAP 2 — Bepalen welke berichten tekst en foto nodig hebben");
  const feedUrls = await leesFeedUrls();
  // Afspraak 7: feed-berichten binnen het pitch-venster worden opnieuw
  // verrijkt. Zonder deze fix gaan ze met 250 tekens naar de AI.
  const teVerrijken = alleBerichten.filter((b) => {
    if (!nietInToekomst(b.gepubliceerdOp)) return false;
    const inFeed = feedUrls.has(b.url);
    const inVenster = binnen(b);
    if (inFeed && !inVenster) return false;
    return true;
  });
  const herverrijkt = teVerrijken.filter((b) => feedUrls.has(b.url) && binnen(b)).length;
  console.log(`Tekst/foto nodig voor ${teVerrijken.length} van ${alleBerichten.length} unieke bericht(en).`);
  console.log(`(${recenteBerichten.length} voor de pitch, ${teVerrijken.length} voor de feed; ${herverrijkt} feed-berichten worden opnieuw verrijkt.)`);

  logFase("STAP 3 — Tekst en foto ophalen");
  const startTekst = Date.now();
  try {
    const { perBron } = await vulBerichtenAanMetTekst(teVerrijken, {
      nietOphalen: (b) =>
        GEEN_TEKSTOPHAAL_TYPES.has(bronPerId[b.bronId] && bronPerId[b.bronId].type)
        || GEEN_TEKSTOPHAAL_BRONNEN.has(b.bronId),
      detailSelectorVoor: (b) => {
        const bron = bronPerId[b.bronId];
        return bron && bron.detailSelector ? bron.detailSelector : null;
      },
    });
    for (const bron of bronnen) {
      const s = perBron[bron.id];
      if (!s) continue;
      console.log(`[${bron.id}] ${tekstStatistiekRegel(s)}`);
      if (s.totaal > 0 && s.metTekst === 0) {
        console.warn(`[${bron.id}] Geen enkel bericht met artikeltekst: de AI ziet van deze bron alleen lijstgegevens.`);
      }
    }
  } catch (fout) {
    console.error(`Tekst/foto ophalen mislukte onverwacht (de berichten gaan door met de lijstgegevens): ${fout.message}${oorzaakTekst(fout)}`);
  }
  logDuur(startTekst, "Tekst en foto ophalen");

  logFase("STAP 4 — Nieuwsfeed bijwerken");
  try {
    await werkFeedBij(alleBerichten, bronPerId);
  } catch (fout) {
    console.error(`Nieuwsfeed bijwerken mislukte onverwacht (de rest van de run gaat door): ${fout.message}${oorzaakTekst(fout)}`);
  }

  logFase("STAP 4b — Weekagenda bijwerken (zonder AI)");
  try {
    const bestaandeAgenda = await leesJson("agenda.json", { items: [] });
    const { items, stats } = bouwAgenda({
      ruweBerichten,
      bronPerId,
      bestaand: Array.isArray(bestaandeAgenda.items) ? bestaandeAgenda.items : [],
    });
    await schrijfJson("agenda.json", { gegenereerdOp: new Date().toISOString(), items });
    const zonderTijd = items.filter((i) => !i.heeftTijd).length;
    console.log(
      `Agenda bijgewerkt: ${items.length} items (${stats.nieuw} nieuw, ${stats.bijgewerkt} bijgewerkt, `
        + `${stats.behouden} behouden, ${stats.verdwenen} verdwenen, ${stats.verlopen} verlopen); `
        + `${zonderTijd} zonder tijd.`
    );
  } catch (fout) {
    console.error(`Agenda bijwerken mislukte onverwacht (de rest van de run gaat door): ${fout.message}${oorzaakTekst(fout)}`);
  }

  logFase("STAP 5 — Berichten voor de pitches filteren");
  const berichtenVanVandaag = alleBerichten.filter(binnen);
  console.log(`Voor de pitches: ${berichtenVanVandaag.length} van ${alleBerichten.length} unieke bericht(en) vallen binnen het venster.`);

  logFase("STAP 6 — Splitsen en sorteren op datum");
  const lokaal = sorteerOpDatum(berichtenVanVandaag.filter((b) => b.categorie === "lokaal"), bronPerId);
  const landelijk = sorteerOpDatum(berichtenVanVandaag.filter((b) => b.categorie === "landelijk"), bronPerId);

  const datumKort = (b) => (b ? (kalenderdagAmsterdam(b.gepubliceerdOp) || "-") : "-");
  console.log(`Lokaal: ${lokaal.length} berichten (dichtstbijzijnde datum: ${datumKort(lokaal[0])}).`);
  console.log(`Landelijk: ${landelijk.length} berichten (dichtstbijzijnde datum: ${datumKort(landelijk[0])}).`);

  await schrijfJson("nieuws-lokaal.json", lokaal);
  await schrijfJson("nieuws-landelijk.json", landelijk);

  logFase("STAP 6b — Nieuwsdienst (ZANP) bijwerken");
  try {
    for (const bron of bronnen) {
      if (!isBekendeBron(bron.id)) {
        console.warn(`[${bron.id}] Staat niet in rubrieken.js: rubriek Overig, prio 3, geen AI-tekst. Voeg de bron daar toe.`);
      }
    }
    const vorigeBerichten = await leesJson("berichten.json", { berichten: [] });
    const bestaand = Array.isArray(vorigeBerichten.berichten) ? vorigeBerichten.berichten : [];
    const feedItems = await leesJson("feed.json", []);
    const nu = new Date();

    const vensterNieuws = berichtenVanVandaag.filter((b) => !isAgendaItem(b));
    const { nieuwe, stats } = planBerichten({
      vensterBerichten: vensterNieuws,
      feedItems: Array.isArray(feedItems) ? feedItems : [],
      bestaand,
      nu,
    });
    console.log(
      `Berichten: ${stats.nieuw} nieuw, ${stats.update} nieuwe versie(s), ${stats.opnieuw} opnieuw voor AI-tekst, ${stats.ongewijzigd} ongewijzigd`
        + `${bestaand.length === 0 ? `, ${stats.seed} kale signalen uit de feed (eerste run)` : ""}.`
    );

    let verwerkt = nieuwe.map((n) => n.record);
    const teSchrijven = nieuwe.filter((n) => n.invoer);
    if (apiKey && teSchrijven.length > 0) {
      console.log(`Meldingen schrijven voor ${teSchrijven.length} bericht(en) (cap ${WIRE_CAP}, prompt ${PROMPT_VERSIE_WIRE}, minimaal ${MIN_TEKST_VOOR_AI} tekens brontekst).`);
      const resultaten = await schrijfMeldingen(teSchrijven.map((n) => n.invoer), apiKey, WIRE_CAP);
      verwerkt = nieuwe.map((n) => (n.invoer ? verwerkMelding(n, resultaten.get(n.invoer.id)) : n.record));
      const telling = {};
      for (const r of verwerkt) if (r.controle) telling[r.controle] = (telling[r.controle] || 0) + 1;
      console.log(`Controle-uitkomsten: ${JSON.stringify(telling)}`);
    } else if (!apiKey && teSchrijven.length > 0) {
      console.log(`Geen API-sleutel: ${teSchrijven.length} bericht(en) blijven kop + link.`);
    }

    const eind = voegBerichtenSamen(bestaand, verwerkt, nu);
    await schrijfJson("berichten.json", {
      gegenereerdOp: nu.toISOString(),
      promptVersie: PROMPT_VERSIE_WIRE,
      prioSchaal: "1 = urgent, 2 = belangrijk, 3 = regulier, 4 = routine. De AI geeft nooit prio 1.",
      rubrieken: RUBRIEKEN,
      berichten: eind,
    });
    console.log(`Nieuwsdienst bijgewerkt: ${eind.length} berichten in de stroom, ${eind.filter((r) => r.ai).length} met AI-tekst.`);
  } catch (fout) {
    console.error(`Nieuwsdienst bijwerken mislukte onverwacht (de rest van de run gaat door): ${fout.stack || fout.message}`);
  }

  if (!apiKey) {
    console.log("Klaar (zonder AI-beoordeling).");
    return;
  }

  logFase("STAP 7 — Filter (agenda) en pitch (alle berichten)");
  const startGemini = Date.now();

  const lokaalAgenda = lokaal.filter(isAgendaItem);
  const lokaalNieuws = lokaal.filter((b) => !isAgendaItem(b));
  const landelijkAgenda = landelijk.filter(isAgendaItem);
  const landelijkNieuws = landelijk.filter((b) => !isAgendaItem(b));

  // Afspraak 1 en 2: alleen agenda door het criteria-filter.
  console.log(`Filter (agenda): lokaal ${lokaalAgenda.length}, landelijk ${landelijkAgenda.length}.`);
  const lokaalAgendaGefilterd = await beoordeelBerichten(lokaalAgenda, apiKey, DAGCAP_GEMINI, "lokaal");
  const landelijkAgendaGefilterd = await beoordeelBerichten(landelijkAgenda, apiKey, DAGCAP_GEMINI, "landelijk");

  const lokaalAgendaKansrijk = lokaalAgendaGefilterd.filter(
    (b) => scoreVan(b) >= DREMPEL.lokaal && b.aiBeoordeling && b.aiBeoordeling.centraleVraag
  );
  const landelijkAgendaKansrijk = landelijkAgendaGefilterd.filter(
    (b) => scoreVan(b) >= DREMPEL.landelijk && b.aiBeoordeling && b.aiBeoordeling.centraleVraag
  );
  console.log(
    `Kansrijke agenda: ${lokaalAgendaKansrijk.length} lokaal, ${landelijkAgendaKansrijk.length} landelijk.`
  );

  // Afspraak 1 en 3: alle nieuws + kansrijke agenda gaan naar de pitch.
  const tePitchen = [
    ...lokaalNieuws,
    ...landelijkNieuws,
    ...lokaalAgendaKansrijk,
    ...landelijkAgendaKansrijk,
  ];
  console.log(
    `Pitch: ${tePitchen.length} berichten (${lokaalNieuws.length + landelijkNieuws.length} nieuws + ${lokaalAgendaKansrijk.length + landelijkAgendaKansrijk.length} agenda).`
  );

  const gepitcht = await genereerPitches(tePitchen, apiKey, DAGCAP_GEMINI * 2, "gemengd");

  const pitchMap = new Map(gepitcht.map((p) => [p.url, p]));
  const lokaalEind = lokaal.map((b) => pitchMap.get(b.url) || b);
  const landelijkEind = landelijk.map((b) => pitchMap.get(b.url) || b);

  logDuur(startGemini, "Filter en pitch");

  await schrijfJson("nieuws-lokaal.json", lokaalEind);
  await schrijfJson("nieuws-landelijk.json", landelijkEind);

  logFase("STAP 8 — Pitches samenstellen op datum");
  // Afspraak 5: nieuwste eerst, geen codescore-sortering meer.
  const topPitches = stelPitchesSamen(gepitcht, AANTAL_PITCHES);

  await schrijfJson("pitches.json", {
    gegenereerdOp: new Date().toISOString(),
    promptVersie: PROMPT_VERSIE,
    sorteerwijze: "datum",
    aantalBerichtenTotaal: berichtenVanVandaag.length,
    drempels: {
      lokaal: DREMPEL.lokaal,
      landelijk: DREMPEL.landelijk,
      maxLokaal: MAX_SCORE_LOKAAL,
      maxLandelijk: MAX_SCORE_LANDELIJK,
    },
    topPitches,
  });

  console.log(`Pitches: ${topPitches.length} van ${gepitcht.filter((p) => p.aiBeoordeling && p.aiBeoordeling.werktitel).length} succesvol gepitchte bericht(en) opgenomen (top ${AANTAL_PITCHES}, gesorteerd op datum).`);
  if (topPitches.length > 0) {
    const datums = topPitches.map((p) => kalenderdagAmsterdam(p.gepubliceerdOp)).filter(Boolean);
    if (datums.length > 0) {
      console.log(`Datums in top ${topPitches.length}: ${datums[0]} t/m ${datums[datums.length - 1]}.`);
    }
  }

  const kansrijkPerBron = {};
  for (const b of gepitcht) {
    if (b.aiBeoordeling && b.aiBeoordeling.werktitel) {
      kansrijkPerBron[b.bronId] = (kansrijkPerBron[b.bronId] || 0) + 1;
    }
  }
  schrijfBijdrageTabel({
    gevondenPerBron: tellingen.gevondenPerBron,
    overPerBron: tellingen.overPerBron,
    kansrijkPerBron,
  });

  logDuur(startRun, "Dagelijkse run");
  console.log(`Klaar: ${topPitches.length} pitches gegenereerd.`);
}

main().catch((fout) => {
  console.error(`Dagelijkse run stopte met een fout: ${fout.stack || fout.message}`);
  process.exit(1);
});
