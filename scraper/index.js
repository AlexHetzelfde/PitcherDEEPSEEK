// index.js — hoofdscript van de dagelijkse run
//
// Volgorde:
// 1. Scrapen — alle bronnen, alle berichten
// 2. Bepaal welke berichten tekst/foto nodig hebben + geef detailSelector mee
// 3. Tekst en foto ophalen (met schone extractie)
// 4. Nieuwsfeed bijwerken
// 5. Voor de pitches: filter op het pitch-venster
// 6. Splitsen en sorteren
// 7. Gemini-beoordeling (filter + pitch per bericht)
// 8. Gemini-ranking (één call voor alle pitches samen)
// 9. Pitches rangschikken en wegschrijven
//
// Sinds de "rustige-agenda-en-feed-consistentie"-ronde (2026-10-15):
//  - In logBronOverzicht wordt voor agenda-bronnen met 0 berichten binnen het
//    venster onderscheid gemaakt tussen "wel leesbare datums, geen evenement
//    vandaag" (rustige dag, geen waarschuwing) en "geen enkele leesbare
//    datum" (datumherkenning kan kapot zijn, wél waarschuwen).
//  - In werkFeedBij wordt de "soort"-vlag van elk bestaand feed-item
//    opnieuw berekend op basis van de huidige bron-config.
//
// Sinds de "feed-bronidentiteit"-ronde (2026-10-15):
//  - bepaalFeedSoort matchte op bronNaam, maar twee bronnen zijn ooit
//    hernoemd terwijl oude feed-items nog de oude naam droegen. Daardoor
//    werden agenda-items van die twee bronnen bij elke run ten onrechte
//    naar "nieuws" geflipt. Nu: (1) nieuwe feed-items krijgen een bronId
//    mee, (2) bestaande items zonder bronId krijgen er één bijgeplakt op
//    basis van naam of alias, en (3) een alias-tabel overbrugt de
//    historische namen.
//
// Sinds de "eerlijke-pipeline"-ronde (2026-10-15):
//  - De .map() die voor bronnen met een detailSelector een kopie maakte, is
//    weg. Die kopie werd verrijkt met tekst/foto, maar Stap 4 (feed) en
//    Stap 5 (Gemini) lazen de originelen — waardoor bronnen met een
//    detailSelector (WaarheenAgenda, zaanstad-hoorzittingen) in de praktijk
//    altijd zonder tekst naar Gemini gingen en alle items "nee" kregen.
//    Nu geeft index.js een detailSelectorVoor-callback mee aan
//    vulBerichtenAanMetTekst, zodat die op de originele objecten werkt.
//  - In werkBronGezondheidBij telt een herhaalde run op dezelfde
//    kalenderdag niet mee voor de "opeenvolgend leeg"-tellers. Handmatige
//    runs op dezelfde dag lieten de tellers eerder onterecht oplopen.
//  - In werkFeedBij wordt de bronNaam van bestaande items bijgewerkt naar de
//    huidige naam uit bronnen.js. Zonder deze stap zou een rename (zoals de
//    vijf bronnen met naam == id) oude items achterlaten met de oude naam.

const fs = require("fs/promises");
const path = require("path");

const bronnen = require("./bronnen");
const { scraperVoorType } = require("./scraper-register");
const { beoordeelBerichten, rangschikPitches } = require("./gemini");
const {
  binnenVenster,
  MAX_LEEFTIJD_DAGEN,
  oorzaakTekst,
  vulBerichtenAanMetTekst,
  tekstStatistiekRegel,
  agendaUitDatums,
} = require("./hulpmiddelen");

const DATA_MAP = path.join(__dirname, "..", "data");
const DAGCAP_GEMINI = Number(process.env.DAGCAP_GEMINI || 100);
const AANTAL_PITCHES = Number(process.env.AANTAL_PITCHES || 10);
const FEED_MAX_ITEMS = Number(process.env.FEED_MAX_ITEMS || 200);
const FEED_SAMENVATTING_TEKENS = Number(process.env.FEED_SAMENVATTING_TEKENS || 250);

const GEEN_TEKSTOPHAAL_TYPES = new Set(["ibabs"]);
const PAGINADATUM_TYPES = new Set(["gemini-recept", "generieke-lijst", "wordpress-html", "json-ld"]);
const afgeleideAgenda = new Map();
function effectieveBron(bron) {
  return afgeleideAgenda.has(bron.id) ? { ...bron, soort: "agenda" } : bron;
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
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "ongeldige datum";
  const datumTekst = d.toISOString().slice(0, 10);
  const dagen = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (dagen === 0) return `${datumTekst} (vandaag)`;
  if (dagen === 1) return `${datumTekst} (gisteren)`;
  if (dagen === -1) return `${datumTekst} (morgen)`;
  if (dagen > 0) return `${datumTekst} (${dagen} dagen oud)`;
  return `${datumTekst} (over ${-dagen} dagen)`;
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
    if (gevonden === 0) {
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

/** Geeft de kalenderdag (YYYY-MM-DD) van een ISO-tijdstip in Nederlandse tijd. */
function kalenderdag(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
}

/**
 * Werkt bron-gezondheid.json bij. Belangrijk: een tweede run op dezelfde
 * kalenderdag telt niet mee voor de "opeenvolgend leeg"-tellers. Zonder die
 * regel liet een handmatige testrun de tellers direct oplopen, waarna
 * herstel-bronnen.js na 2 runs al een issue aanmaakte over een bron die
 * gewoon een rustige dag had.
 *
 * Als een run wél berichten vindt, gaan de tellers altijd naar 0 — ook als de
 * vorige run dezelfde dag was. Anders zou een geslaagde handmatige herstelrun
 * de teller niet resetten, en zou de volgende dag als "opeenvolgend leeg"
 * doorgaan.
 */
async function werkBronGezondheidBij({ gevondenPerBron, overPerBron }) {
  let vorige = {};
  try {
    vorige = JSON.parse(await fs.readFile(GEZONDHEID_BESTAND, "utf-8"));
  } catch {
    /* eerste run */
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
    const binnenVenster = overPerBron[bron.id] || 0;
    const eerder = vorige[bron.id];
    const eerderBerichten = eerder && {
      teller: eerder.opeenvolgendGeenBerichten,
      dag: kalenderdag(eerder.laatsteRun),
    };
    const eerderVenster = eerder && {
      teller: eerder.opeenvolgendGeenBinnenVenster,
      dag: kalenderdag(eerder.laatsteRun),
    };
    nieuw[bron.id] = {
      laatsteRun: new Date().toISOString(),
      gevonden,
      binnenVenster,
      opeenvolgendGeenBerichten: volgendeTeller(gevonden, eerderBerichten),
      opeenvolgendGeenBinnenVenster: volgendeTeller(binnenVenster, eerderVenster),
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
      const berichten = await scraper(bron);
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
  const geziereUrls = new Set();
  return berichten.filter((b) => {
    if (!b.url || geziereUrls.has(b.url)) return false;
    geziereUrls.add(b.url);
    return true;
  });
}

async function schrijfJson(bestandsnaam, data) {
  await fs.mkdir(DATA_MAP, { recursive: true });
  await fs.writeFile(path.join(DATA_MAP, bestandsnaam), JSON.stringify(data, null, 2), "utf-8");
}

function kortAfTekst(tekst, max) {
  const t = (tekst || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const stuk = t.slice(0, max);
  const laatsteSpatie = stuk.lastIndexOf(" ");
  return `${(laatsteSpatie > max - 40 ? stuk.slice(0, laatsteSpatie) : stuk).trim()}…`;
}

function binnenFeedVenster(iso) {
  if (!iso) return false;
  const d = new Date(iso).getTime();
  if (isNaN(d)) return false;
  const nu = new Date();
  const eindVandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate() + 1).getTime();
  return d < eindVandaag;
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

/**
 * Historische namen van bronnen die ooit zijn hernoemd in bronnen.js, maar
 * waarvan de oude items nog in feed.json staan. Zonder deze tabel zou
 * bepaalFeedSoort die items niet herkennen en ze ten onrechte "nieuws" geven.
 * Nieuwe items krijgen een bronId en hebben deze tabel niet meer nodig.
 */
const FEED_BRON_ALIASSEN = {
  "zaans-cultuur-huis": "Zaans Cultuurhuis — Agenda",
  "zaanstad-hoorzittingen": "Zaanstad — Hoorzittingen",
  hhnk: "Hoogheemraadschap Hollands Noorderkwartier — Nieuws",
  "zaandijk-leeft": "Zaandijk Leeft!",
  OmgevingsdienstNHN: "Omgevingsdienst Noord-Holland Noord",
  omgevingsdienstnoordzeekanaal: "Omgevingsdienst Noordzeekanaalgebied",
  WaarheenAgenda: "Waarheen Agenda (De Orkaan)",
};

/**
 * Bouwt twee lookups in één keer: op id en op naam. Wordt aan werkFeedBij
 * meegegeven zodat elk feed-item in O(1) zijn bron vindt (in plaats van een
 * find over alle bronnen per item).
 */
function maakBronLookup(bronPerId) {
  const perId = new Map();
  const perNaam = new Map();
  for (const bron of Object.values(bronPerId)) {
    perId.set(bron.id, bron);
    perNaam.set(bron.naam, bron);
  }
  return { perId, perNaam };
}

/**
 * Vindt de bronconfiguratie die bij een feed-item hoort.
 * Volgorde: bronId → bronNaam → alias → niets.
 * Geeft null als geen van de drie lukt (het item blijft dan gewoon staan
 * met zijn bestaande soort; we forceren geen "nieuws" meer).
 */
function vindBronVoorItem(item, lookup) {
  if (item.bronId && lookup.perId.has(item.bronId)) return lookup.perId.get(item.bronId);
  if (item.bronNaam && lookup.perNaam.has(item.bronNaam)) return lookup.perNaam.get(item.bronNaam);
  const alias = item.bronNaam ? FEED_BRON_ALIASSEN[item.bronNaam] : null;
  if (alias && lookup.perNaam.has(alias)) return lookup.perNaam.get(alias);
  return null;
}

/**
 * Werkt de nieuwsfeed bij:
 *  1. Herberekent de "soort"-vlag van elk bestaand item op basis van de
 *     huidige bron-config (via bronId, naam of alias).
 *  2. Plakt een ontbrekend bronId op bestaande items bij, zodat de naam-
 *     lookup op termijn niet meer nodig is.
 *  3. Vervangt de bronNaam van bestaande items door de huidige naam uit
 *     bronnen.js, zodat een latere rename geen oude namen achterlaat.
 *  4. Voegt nieuwe berichten toe en capt op FEED_MAX_ITEMS.
 */
async function werkFeedBij(berichten, bronPerId) {
  const feedPad = path.join(DATA_MAP, "feed.json");
  const lookup = maakBronLookup(bronPerId);

  let bestaand = [];
  try {
    const inhoud = JSON.parse(await fs.readFile(feedPad, "utf-8"));
    if (Array.isArray(inhoud)) bestaand = inhoud;
  } catch {
    /* eerste run, of ongeldig bestand: begin met leeg */
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
  bestaand = bestaand.filter((b) => binnenFeedVenster(b.gepubliceerdOp));
  const uitToekomst = voorToekomst - bestaand.length;

  const bestaandeUrls = new Set(bestaand.map((b) => b.url).filter(Boolean));
  const nieuw = [];
  for (const b of berichten) {
    if (!b.url || bestaandeUrls.has(b.url)) continue;
    if (!binnenFeedVenster(b.gepubliceerdOp)) continue;
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
  const gecapt = samen.slice(0, FEED_MAX_ITEMS);
  const verwijderd = samen.length - gecapt.length;
  const metFoto = gecapt.filter((b) => b.foto).length;

  await schrijfJson("feed.json", gecapt);
  console.log(
    `Feed bijgewerkt: ${nieuw.length} nieuw, ` +
      `${uitToekomst > 0 ? `${uitToekomst} uit de toekomst gefilterd, ` : ""}` +
      `${gecapt.length} in de feed` +
      `${verwijderd > 0 ? `, ${verwijderd} oudste verwijderd (cap = ${FEED_MAX_ITEMS})` : ""}` +
      `, ${metFoto} met foto.`
  );
  if (soortGecorrigeerd > 0) {
    console.log(`  waarvan ${soortGecorrigeerd} bestaand(e) item(s) met een gecorrigeerde soort-vlag.`);
  }
  if (idBijgeplakt > 0) {
    console.log(`  ${idBijgeplakt} bestaand(e) item(s) kregen een bronId (voortaan geen naam-lookup meer nodig).`);
  }
  if (naamGecorrigeerd > 0) {
    console.log(`  ${naamGecorrigeerd} bestaand(e) item(s) kregen de huidige bronNaam.`);
  }
}

function prioriteitVan(bericht) {
  const p = bericht.aiBeoordeling && bericht.aiBeoordeling.prioriteit;
  return Number.isInteger(p) && p >= 1 && p <= 10 ? p : 0;
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

function stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, aantal) {
  const gecombineerd = [...kansrijkeLokaal, ...kansrijkLandelijk];
  const zonderPrioriteit = gecombineerd.filter((b) => prioriteitVan(b) === 0);
  if (zonderPrioriteit.length > 0) {
    console.warn(`${zonderPrioriteit.length} kansrijk(e) bericht(en) zonder geldige prioriteit; die komen onderaan de pitchlijst.`);
  }
  return gecombineerd.sort((a, b) => prioriteitVan(b) - prioriteitVan(a)).slice(0, aantal);
}

async function main() {
  const startRun = Date.now();
  console.log(`Start dagelijkse run: ${new Date().toISOString()}`);
  console.log(`Instellingen: dagcap=${DAGCAP_GEMINI}/lijst, pitches=${AANTAL_PITCHES}, feedcap=${FEED_MAX_ITEMS}`);
  console.log(`Tijdzone: ${process.env.TZ || "(systeemstandaard)"} → lokale tijd ${new Date().toLocaleString("nl-NL")}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "GEMINI_API_KEY is niet gezet — het scrapen en sorteren draaien gewoon door, " +
        "maar er worden geen AI-beoordelingen/pitches gegenereerd."
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
  const teVerrijken = alleBerichten.filter((b) => {
    if (binnen(b)) return true;
    if (!feedUrls.has(b.url) && binnenFeedVenster(b.gepubliceerdOp)) return true;
    return false;
  });
  console.log(`Tekst/foto nodig voor ${teVerrijken.length} van ${alleBerichten.length} unieke bericht(en).`);
  console.log(`(${recenteBerichten.length} voor Gemini, ${teVerrijken.length - recenteBerichten.length} nieuw voor de feed.)`);

  logFase("STAP 3 — Tekst en foto ophalen");
  const startTekst = Date.now();
  try {
    // De detailSelector komt via een callback mee, zodat
    // vulBerichtenAanMetTekst op de originele objecten werkt. Voorheen maakte
    // deze stap een kopie en ging de verrijking verloren voor Stap 4 en 5.
    const { perBron } = await vulBerichtenAanMetTekst(teVerrijken, {
      nietOphalen: (b) => GEEN_TEKSTOPHAAL_TYPES.has(bronPerId[b.bronId] && bronPerId[b.bronId].type),
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
        console.warn(`[${bron.id}] Geen enkel bericht met tekst: Gemini ziet van deze bron alleen titels.`);
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

  logFase("STAP 5 — Berichten voor de pitches filteren");
  const berichtenVanVandaag = alleBerichten.filter(binnen);
  console.log(`Voor de pitches: ${berichtenVanVandaag.length} van ${alleBerichten.length} unieke bericht(en) vallen binnen het venster.`);

  logFase("STAP 6 — Splitsen en sorteren op datum");
  const lokaal = sorteerOpDatum(berichtenVanVandaag.filter((b) => b.categorie === "lokaal"), bronPerId);
  const landelijk = sorteerOpDatum(berichtenVanVandaag.filter((b) => b.categorie === "landelijk"), bronPerId);

  const datumKort = (b) => (b ? String(b.gepubliceerdOp).slice(0, 10) : "-");
  console.log(`Lokaal: ${lokaal.length} berichten (dichtstbijzijnde datum: ${datumKort(lokaal[0])}).`);
  console.log(`Landelijk: ${landelijk.length} berichten (dichtstbijzijnde datum: ${datumKort(landelijk[0])}).`);

  await schrijfJson("nieuws-lokaal.json", lokaal);
  await schrijfJson("nieuws-landelijk.json", landelijk);

  if (!apiKey) {
    console.log("Klaar (zonder AI-beoordeling).");
    return;
  }

  logFase("STAP 7 — Gemini-beoordeling");
  const startGemini = Date.now();

  console.log(`Lokaal: ${Math.min(lokaal.length, DAGCAP_GEMINI)} van ${lokaal.length} berichten gaan naar Gemini.`);
  const lokaalBeoordeeld = await beoordeelBerichten(lokaal, apiKey, DAGCAP_GEMINI, "lokaal");

  console.log(`Landelijk: ${Math.min(landelijk.length, DAGCAP_GEMINI)} van ${landelijk.length} berichten gaan naar Gemini.`);
  const landelijkBeoordeeld = await beoordeelBerichten(landelijk, apiKey, DAGCAP_GEMINI, "landelijk");

  logDuur(startGemini, "Gemini-beoordeling");

  await schrijfJson("nieuws-lokaal.json", lokaalBeoordeeld);
  await schrijfJson("nieuws-landelijk.json", landelijkBeoordeeld);

  logFase("STAP 8 — Pitches rangschikken");
  const kansrijkeLokaal = lokaalBeoordeeld.filter((b) => b.aiBeoordeling?.oppakbaar === "ja");
  const kansrijkLandelijk = landelijkBeoordeeld.filter((b) => b.aiBeoordeling?.lokaleInvalshoek === "ja");
  const alleKansrijke = [...kansrijkeLokaal, ...kansrijkLandelijk];
  console.log(`Kansrijke berichten: ${kansrijkeLokaal.length} lokaal, ${kansrijkLandelijk.length} landelijk (${alleKansrijke.length} totaal).`);

  let alleKansrijkeMetScore = alleKansrijke;
  try {
    alleKansrijkeMetScore = await rangschikPitches(alleKansrijke, apiKey);
  } catch (fout) {
    console.error(`Rangschikken mislukte onverwacht (pitches houden prioriteit null): ${fout.message}${oorzaakTekst(fout)}`);
  }

  const scorePerUrl = new Map(alleKansrijkeMetScore.map((b) => [b.url, b.aiBeoordeling?.prioriteit ?? null]));
  const metScoreTerug = (lijst) => lijst.map((b) => scorePerUrl.has(b.url) ? { ...b, aiBeoordeling: { ...(b.aiBeoordeling || {}), prioriteit: scorePerUrl.get(b.url) } } : b);
  await schrijfJson("nieuws-lokaal.json", metScoreTerug(lokaalBeoordeeld));
  await schrijfJson("nieuws-landelijk.json", metScoreTerug(landelijkBeoordeeld));

  logFase("STAP 9 — Top pitches samenstellen");
  const topPitches = stelPitchesSamen(
    alleKansrijkeMetScore.filter((b) => b.categorie === "lokaal"),
    alleKansrijkeMetScore.filter((b) => b.categorie === "landelijk"),
    AANTAL_PITCHES
  );

  await schrijfJson("pitches.json", {
    gegenereerdOp: new Date().toISOString(),
    aantalBerichtenTotaal: berichtenVanVandaag.length,
    topPitches,
  });

  console.log(`Pitches: ${topPitches.length} van ${alleKansrijke.length} kansrijke bericht(en) opgenomen (top ${AANTAL_PITCHES}).`);
  if (topPitches.length > 0) {
    const scores = topPitches.map((p) => prioriteitVan(p)).filter((s) => s > 0);
    if (scores.length > 0) {
      console.log(`Scores in top ${topPitches.length}: min ${Math.min(...scores)}, max ${Math.max(...scores)}, gemiddeld ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)}.`);
    }
  }

  logDuur(startRun, "Dagelijkse run");
  console.log(`Klaar: ${topPitches.length} pitches gegenereerd.`);
}

main().catch((fout) => {
  console.error(`Dagelijkse run stopte met een fout: ${fout.stack || fout.message}`);
  process.exit(1);
});
