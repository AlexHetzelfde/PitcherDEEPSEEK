// index.js — hoofdscript van de dagelijkse run
//
// Volgorde:
// 1. Alles scrapen (per bron, met eigen scraper-type)
// 2. Tellen hoeveel berichten er zijn, VOORDAT Gemini wordt aangeroepen
//    en van elk bericht de tekst ophalen (hulpmiddelen.js), zodat
//    Gemini meer ziet dan alleen een titel
// 3. Splitsen in lokaal/landelijk en sorteren (nieuws eerst, dan agenda) —
//    dat bepaalt wie binnen de dagcap valt
// 4. Per bericht twee Gemini-calls: eerst filteren of het oppakbaar is, dan
//    (alleen voor oppakbare berichten) de pitch en de score
// 5. Pitches rangschikken op de prioriteit (1-10) die Gemini zelf geeft, en
//    wegschrijven naar /data

const fs = require("fs/promises");
const path = require("path");

const bronnen = require("./bronnen");
const { scraperVoorType } = require("./scraper-register");
const { beoordeelBerichten } = require("./gemini");
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
// Brontypes die hun eigen tekst meebrengen (iBabs leest de documenten zelf uit):
// daar halen we geen berichtpagina op, want die URL is een document, geen webpagina.
const GEEN_TEKSTOPHAAL_TYPES = new Set(["ibabs"]);
// Brontypes die de datum uit de pagina zelf lezen. Alleen daar kan een agenda ten onrechte
// als nieuws staan (rss, wp-rest en json-api leveren publicatiedatums).
const PAGINADATUM_TYPES = new Set(["gemini-recept", "generieke-lijst", "wordpress-html", "json-ld"]);
// Bronnen zonder soort "agenda" waarvan de datums er toch op wijzen (id -> melding). Voor deze
// run behandelen we ze als agenda; bronnen.js zelf wijzigt de dagelijkse run nooit.
const afgeleideAgenda = new Map();
function effectieveBron(bron) {
  return afgeleideAgenda.has(bron.id) ? { ...bron, soort: "agenda" } : bron;
}

// --- Kleine logging-helpers, zodat elke fase duidelijk zichtbaar is in de
// Actions-log: een kopregel, en aan het eind hoelang die fase duurde. ---
function logFase(titel) {
  console.log(`\n=== ${titel} — ${new Date().toISOString()} ===`);
}

function logDuur(startMs, label) {
  const duurSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`${label} klaar in ${duurSec}s`);
}

/**
 * Telt per bron hoeveel berichten er gevonden zijn en hoeveel daarvan het
 * venster (leeftijdsfilter, of het agenda-venster) overleefden.
 */
function telPerBron(ruweBerichten, recenteBerichten) {
  const gevondenPerBron = {};
  const overPerBron = {};
  for (const b of ruweBerichten) gevondenPerBron[b.bronId] = (gevondenPerBron[b.bronId] || 0) + 1;
  for (const b of recenteBerichten) overPerBron[b.bronId] = (overPerBron[b.bronId] || 0) + 1;
  return { gevondenPerBron, overPerBron };
}

/**
 * Drukt een duidelijk per-bron statusoverzicht af: hoeveel berichten een
 * bron opleverde, hoeveel daarvan het venster overleefden, en een
 * status-label — zodat een kapotte of stilvallende bron in één oogopslag
 * opvalt tussen de rest van de run-log, zonder dat je de losse regels per
 * bron hoeft na te lopen.
 *
 * Een bron met rustig: true (zie bron-poort.js) is een bron die maar heel
 * weinig berichten toont. Daar is "0 na leeftijdsfilter" normaal en geen
 * reden voor de datum-waarschuwing. "0 gevonden" blijft voor elke bron rood:
 * dat betekent dat de scraper niets meer ziet.
 */
function logBronOverzicht({ gevondenPerBron, overPerBron }) {
  console.log("\n--- Bronoverzicht (gevonden → binnen venster) ---");
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
      status = "⚠️  0 binnen het agenda-venster — check datumherkenning (datums zonder jaar?) of de agenda is leeg";
    } else if (over === 0) {
      status = "⚠️  0 na leeftijdsfilter — check datumherkenning voor deze bron";
    } else {
      status = "✅ OK";
    }

    const soort = bron.soort === "agenda" ? (afgeleideAgenda.has(bron.id) ? " [agenda!]" : " [agenda]") : "";
    console.log(`  ${(bron.id + soort).padEnd(28)} ${String(gevonden).padStart(3)} → ${String(over).padStart(3)}   ${status}`);
  }
  console.log("---\n");
}

const GEZONDHEID_BESTAND = path.join(DATA_MAP, "bron-gezondheid.json");

/**
 * Houdt per bron twee tellers bij. Dat bestand wordt met de rest van
 * data/*.json teruggecommit. herstel-bronnen.js gebruikt ze om pas in actie te
 * komen als het probleem meerdere runs aanhoudt, zodat een tijdelijke storing
 * van een website geen herstelpoging (en geen pull request) uitlokt.
 *   - opeenvolgendGeenBerichten: runs achter elkaar waarin de scraper NIETS
 *     vond (gevonden = 0): de scraper is blind.
 *   - opeenvolgendGeenBinnenVenster: runs achter elkaar waarin niets binnen
 *     het venster viel (binnenVenster = 0). Dat vangt ook een bron die nog wel
 *     berichten vindt, maar waarvan alles door het filter valt (bijvoorbeeld
 *     omdat de datums verkeerd worden gelezen). Telt dus ook de runs mee waarin
 *     niets gevonden werd. Een rustige bron (rustig: true) heeft hier een
 *     ruimere drempel (zie herstel-bronnen.js).
 */
async function werkBronGezondheidBij({ gevondenPerBron, overPerBron }) {
  let vorige = {};
  try {
    vorige = JSON.parse(await fs.readFile(GEZONDHEID_BESTAND, "utf-8"));
  } catch {
    /* eerste run, of bestand nog niet aanwezig */
  }
  const nieuw = {};
  for (const bron of bronnen) {
    const gevonden = gevondenPerBron[bron.id] || 0;
    const binnenVenster = overPerBron[bron.id] || 0;
    const eerder = (vorige[bron.id] && vorige[bron.id].opeenvolgendGeenBerichten) || 0;
    const eerderVenster = (vorige[bron.id] && vorige[bron.id].opeenvolgendGeenBinnenVenster) || 0;
    nieuw[bron.id] = {
      laatsteRun: new Date().toISOString(),
      gevonden,
      binnenVenster,
      opeenvolgendGeenBerichten: gevonden === 0 ? eerder + 1 : 0,
      opeenvolgendGeenBinnenVenster: binnenVenster === 0 ? eerderVenster + 1 : 0,
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

      // Vangnet: staat deze bron als nieuws, maar zijn de datums die van een agenda? Dan zou
      // elk toekomstig evenement als nieuws tellen. Voor deze run behandelen we hem als agenda
      // en we zeggen er luid bij wat er in bronnen.js moet veranderen.
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
      // Eén kapotte bron mag de hele dagelijkse run niet laten crashen.
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

/**
 * De prioriteit (1-10) die Gemini aan een bericht gaf, of 0 als die ontbreekt
 * of ongeldig is (zie maakPrioriteit in gemini.js). Er is geen eigen
 * puntensysteem meer: dit is het enige cijfer in het hele systeem.
 */
function prioriteitVan(bericht) {
  const p = bericht.aiBeoordeling && bericht.aiBeoordeling.prioriteit;
  return Number.isInteger(p) && p >= 1 && p <= 10 ? p : 0;
}

/**
 * Sorteert berichten zodat nieuwsberichten vóór agenda-items komen. Binnen
 * nieuws: nieuwste eerst. Binnen agenda: dichtstbijzijnde datum eerst.
 * Dit bepaalt wie binnen de dagcap valt; er verdwijnt niets.
 *
 * bronPerId is nodig om te weten welke berichten van een agenda-bron komen.
 */
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
 * Combineert kansrijke lokale en landelijke berichten tot de uiteindelijke
 * pitchlijst, gerangschikt op de prioriteit die Gemini gaf (hoog naar laag).
 * Bij gelijke prioriteit gaat lokaal voor landelijk (de lokale berichten staan
 * vooraan en sort() is stabiel), en blijft de datumvolgorde binnen een lijst
 * behouden.
 */
function stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, aantal) {
  const gecombineerd = [...kansrijkeLokaal, ...kansrijkLandelijk];
  const zonderPrioriteit = gecombineerd.filter((b) => prioriteitVan(b) === 0);
  if (zonderPrioriteit.length > 0) {
    console.warn(`${zonderPrioriteit.length} kansrijk(e) bericht(en) zonder geldige prioriteit van Gemini; die komen onderaan de pitchlijst.`);
  }
  return gecombineerd.sort((a, b) => prioriteitVan(b) - prioriteitVan(a)).slice(0, aantal);
}

async function main() {
  const startRun = Date.now();
  console.log(`Start dagelijkse run: ${new Date().toISOString()}`);
  console.log(`Instellingen: dagcap=${DAGCAP_GEMINI}/lijst, pitches=${AANTAL_PITCHES}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(
      "GEMINI_API_KEY is niet gezet — het scrapen en sorteren draaien gewoon door, " +
        "maar er worden geen AI-beoordelingen/pitches gegenereerd."
    );
  }

  // Stap 1: scrapen. Elke run begint opnieuw: alles ophalen, filteren op het
  // venster van vandaag, en de uitvoerbestanden overschrijven. Er is geen
  // geheugen van eerdere runs, dus een run kan altijd opnieuw gedraaid worden.
  logFase("STAP 1 — Scrapen");
  const startScrapen = Date.now();
  const ruweBerichten = await scrapeAlleBronnen();
  logDuur(startScrapen, `Scrapen van ${bronnen.length} bronnen`);
  console.log(`Ruw aantal berichten (vóór leeftijdsfilter/dedup): ${ruweBerichten.length}`);

  // Centrale leeftijdsgrens — geldt voor ALLE bronnen tegelijk, hier op één
  // plek, in plaats van los per scraper (dat leidde er eerder toe dat de
  // grens alleen bij iBabs was toegepast en nergens anders). Een bericht
  // zonder betrouwbare datum wordt hier ook geweerd, niet uit voorzichtigheid
  // meegenomen — zie de toelichting bij binnenLeeftijdsgrens() in
  // hulpmiddelen.js voor waarom dat bewust zo is.
  //
  // Agenda-bronnen (soort: "agenda") krijgen een eigen venster: alleen
  // evenementen die VANDAAG beginnen. Langlopende evenementen (met eindDatum)
  // tellen alleen mee als ze vandaag beginnen.
  const bronPerId = Object.fromEntries(bronnen.map((b) => [b.id, effectieveBron(b)]));
  const binnen = (b) => binnenVenster(b.gepubliceerdOp, bronPerId[b.bronId], b.eindDatum);
  const recenteBerichten = ruweBerichten.filter(binnen);
  const perBronZonderDatum = {};
  for (const b of ruweBerichten) {
    if (!binnen(b)) {
      perBronZonderDatum[b.bronId] = (perBronZonderDatum[b.bronId] || 0) + 1;
    }
  }
  console.log(`Na leeftijdsfilter (max ${MAX_LEEFTIJD_DAGEN} dagen; agenda-bronnen: alleen vandaag): ${recenteBerichten.length} van ${ruweBerichten.length} berichten.`);
  for (const [bronId, aantal] of Object.entries(perBronZonderDatum)) {
    console.warn(`[${bronId}] ${aantal} bericht(en) geweerd door leeftijdsfilter (te oud, buiten het venster, of geen betrouwbare datum).`);
  }
  const tellingen = telPerBron(ruweBerichten, recenteBerichten);
  logBronOverzicht(tellingen);
  await werkBronGezondheidBij(tellingen);

  // Stap 1b: dubbele url's binnen deze run eruit.
  const berichtenVanVandaag = verwijderDubbelen(recenteBerichten);

  // Stap 2: tellen, vóórdat de AI wordt aangeroepen
  console.log(`Totaal aantal berichten binnen het venster (na ontdubbeling): ${berichtenVanVandaag.length}`);

  // Stap 2b: de tekst van elk bericht ophalen. De lijstpagina geeft
  // meestal alleen een titel; Gemini heeft de tekst nodig om het gevolg voor
  // mensen te kunnen beoordelen. Het resultaat komt in het bestaande veld
  // samenvatting. Mislukt het ophalen, dan gaat het bericht door met de
  // lijsttekst; deze stap mag de run nooit laten crashen.
  logFase("STAP 2 — Tekst per bericht ophalen");
  const startTekst = Date.now();
  try {
    const { perBron } = await vulBerichtenAanMetTekst(berichtenVanVandaag, {
      nietOphalen: (b) => GEEN_TEKSTOPHAAL_TYPES.has(bronPerId[b.bronId] && bronPerId[b.bronId].type),
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
    console.error(`Tekst ophalen mislukte onverwacht (de berichten gaan door met de lijsttekst): ${fout.message}${oorzaakTekst(fout)}`);
  }
  logDuur(startTekst, "Tekst ophalen");

  // Stap 3: splitsen + sorteren (nieuws eerst, dan agenda). Dit bepaalt
  // wie binnen de dagcap valt als er meer berichten zijn dan de cap.
  logFase("STAP 3 — Splitsen en sorteren op datum");
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

  // Stap 4: Gemini-beoordeling, met dagcap per lijst. Twee calls per bericht:
  // eerst filteren of het oppakbaar is, dan (alleen voor oppakbare berichten)
  // de pitch en de score.
  logFase("STAP 4 — Gemini-beoordeling");
  const startGemini = Date.now();

  console.log(`Lokaal: ${Math.min(lokaal.length, DAGCAP_GEMINI)} van ${lokaal.length} berichten gaan naar Gemini.`);
  const lokaalBeoordeeld = await beoordeelBerichten(lokaal, apiKey, DAGCAP_GEMINI, "lokaal");

  console.log(`Landelijk: ${Math.min(landelijk.length, DAGCAP_GEMINI)} van ${landelijk.length} berichten gaan naar Gemini.`);
  const landelijkBeoordeeld = await beoordeelBerichten(landelijk, apiKey, DAGCAP_GEMINI, "landelijk");

  logDuur(startGemini, "Gemini-beoordeling");

  await schrijfJson("nieuws-lokaal.json", lokaalBeoordeeld);
  await schrijfJson("nieuws-landelijk.json", landelijkBeoordeeld);

  // Stap 5: pitches samenstellen, gerangschikt op Gemini's prioriteit.
  logFase("STAP 5 — Pitches samenstellen");
  const kansrijkeLokaal = lokaalBeoordeeld.filter((b) => b.aiBeoordeling?.oppakbaar === "ja");
  const kansrijkLandelijk = landelijkBeoordeeld.filter((b) => b.aiBeoordeling?.lokaleInvalshoek === "ja");
  console.log(`Kansrijk: ${kansrijkeLokaal.length} lokaal, ${kansrijkLandelijk.length} landelijk (vóór rangschikking op prioriteit).`);

  const pitches = stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, AANTAL_PITCHES);
  const aantalLokaalInPitches = pitches.filter((p) => p.categorie === "lokaal").length;
  console.log(`Pitches samengesteld: ${aantalLokaalInPitches} lokaal, ${pitches.length - aantalLokaalInPitches} landelijk.`);

  await schrijfJson("pitches.json", {
    gegenereerdOp: new Date().toISOString(),
    aantalBerichtenTotaal: berichtenVanVandaag.length,
    topPitches: pitches,
  });

  logDuur(startRun, "\nVolledige run");
  console.log(`Klaar. ${pitches.length} pitch(es) klaargezet.`);
}

main().catch((fout) => {
  console.error("Onverwachte fout in de dagelijkse run:", fout);
  process.exit(1);
});
