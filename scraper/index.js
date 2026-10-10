// index.js — hoofdscript van de dagelijkse run
//
// Volgorde:
// 1. Alles scrapen (per bron, met eigen scraper-type)
// 2. Tekst + foto per bericht ophalen voor ALLE unieke berichten
//    (nodig voor de feed; zie Deel B voor "altijd foto ophalen")
// 3. De nieuwsfeed bijwerken (data/feed.json): alles wat deze run gevonden
//    heeft, ontdubbeld op url, gesorteerd op datum (nieuwste eerst), cap 200.
//    De feed is RUIM: ook evenementen in de toekomst en ouder nieuws komen
//    erin, zodat niets verloren gaat.
// 4. Voor de pitches: alleen berichten binnen het venster. Dit is STRIKT:
//    agenda-bronnen alleen vandaag, nieuws max 1 kalenderdag oud.
// 5. Splitsen in lokaal/landelijk en sorteren (nieuws eerst, dan agenda)
// 6. Per bericht twee Gemini-calls: filter, dan pitch + score
// 7. Pitches rangschikken op prioriteit en wegschrijven naar /data

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
// Hoeveel items blijven er in de feed bewaard. Nieuwe items komen bovenaan,
// de oudste vallen eraf als de lijst voller wordt dan dit.
const FEED_MAX_ITEMS = Number(process.env.FEED_MAX_ITEMS || 200);
// Hoeveel tekens van de samenvatting per feed-item bewaard blijven.
const FEED_SAMENVATTING_TEKENS = 250;

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
      status = "⚠️  0 binnen het agenda-venster — check datumherkenning (datums zonder jaar?) of de agenda is leeg";
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

async function werkBronGezondheidBij({ gevondenPerBron, overPerBron }) {
  let vorige = {};
  try {
    vorige = JSON.parse(await fs.readFile(GEZONDHEID_BESTAND, "utf-8"));
  } catch {
    /* eerste run */
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

/** Kapt een tekst af op een woordgrens, met een ellips erachter. */
function kortAfTekst(tekst, max) {
  const t = (tekst || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const stuk = t.slice(0, max);
  const laatsteSpatie = stuk.lastIndexOf(" ");
  return `${(laatsteSpatie > max - 40 ? stuk.slice(0, laatsteSpatie) : stuk).trim()}…`;
}

/**
 * Werkt data/feed.json bij: voegt alle berichten uit deze run toe die nog
 * niet in de feed staan (dedup op url), sorteert op publicatiedatum (nieuwste
 * eerst), en capt op FEED_MAX_ITEMS. De feed is onafhankelijk van Gemini en
 * van het pitch-venster: ook berichten die door Gemini als "nee" zijn
 * beoordeeld, en ook evenementen in de toekomst of ouder nieuws, horen erin.
 */
async function werkFeedBij(berichten, bronPerId) {
  const feedPad = path.join(DATA_MAP, "feed.json");
  let bestaand = [];
  try {
    const inhoud = JSON.parse(await fs.readFile(feedPad, "utf-8"));
    if (Array.isArray(inhoud)) bestaand = inhoud;
  } catch {
    /* eerste run, of ongeldig bestand: begin met leeg */
  }

  const bestaandeUrls = new Set(bestaand.map((b) => b.url).filter(Boolean));
  const nieuw = [];
  for (const b of berichten) {
    if (!b.url || bestaandeUrls.has(b.url)) continue;
    const bron = bronPerId[b.bronId];
    nieuw.push({
      url: b.url,
      titel: b.titel,
      samenvatting: kortAfTekst(b.samenvatting || "", FEED_SAMENVATTING_TEKENS),
      foto: b.foto || null,
      gepubliceerdOp: b.gepubliceerdOp,
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
    `Feed bijgewerkt: ${nieuw.length} nieuw, ${gecapt.length} in de feed` +
      `${verwijderd > 0 ? `, ${verwijderd} oudste verwijderd (cap = ${FEED_MAX_ITEMS})` : ""}` +
      `, ${metFoto} met foto.`
  );
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
    console.warn(`${zonderPrioriteit.length} kansrijk(e) bericht(en) zonder geldige prioriteit van Gemini; die komen onderaan de pitchlijst.`);
  }
  return gecombineerd.sort((a, b) => prioriteitVan(b) - prioriteitVan(a)).slice(0, aantal);
}

async function main() {
  const startRun = Date.now();
  console.log(`Start dagelijkse run: ${new Date().toISOString()}`);
  console.log(`Instellingen: dagcap=${DAGCAP_GEMINI}/lijst, pitches=${AANTAL_PITCHES}, feedcap=${FEED_MAX_ITEMS}`);

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

  // Voor het bronoverzicht: hoeveel berichten vallen binnen het pitch-venster?
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

  // Twee lijsten: één RUIME voor de feed (alles wat deze run gevonden is,
  // ontdubbeld op url), en één STRIKTE voor de pitches (alleen binnen het
  // venster, zie stap 4 hieronder).
  const alleBerichten = verwijderDubbelen(ruweBerichten);
  console.log(`Totaal aantal unieke berichten (voor de feed): ${alleBerichten.length}`);

  // STAP 2 — Tekst én foto per bericht ophalen (op alle unieke berichten,
  // zodat de feed een foto en tekst kan tonen en Gemini de volledige tekst
  // van elk bericht binnen het venster heeft).
  logFase("STAP 2 — Tekst en foto per bericht ophalen");
  const startTekst = Date.now();
  try {
    const { perBron } = await vulBerichtenAanMetTekst(alleBerichten, {
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
    console.error(`Tekst/foto ophalen mislukte onverwacht (de berichten gaan door met de lijstgegevens): ${fout.message}${oorzaakTekst(fout)}`);
  }
  logDuur(startTekst, "Tekst en foto ophalen");

  // STAP 3 — De nieuwsfeed bijwerken (ruim: alles wat deze run gevonden
  // heeft, alleen ontdubbeld op url en gesorteerd op datum).
  logFase("STAP 3 — Nieuwsfeed bijwerken");
  try {
    await werkFeedBij(alleBerichten, bronPerId);
  } catch (fout) {
    console.error(`Nieuwsfeed bijwerken mislukte onverwacht (de rest van de run gaat door): ${fout.message}${oorzaakTekst(fout)}`);
  }

  // STAP 4 — Voor de pitches: alleen berichten binnen het venster. De feed
  // hierboven is bewust ruimer; deze filter bepaalt wat Gemini beoordeelt.
  logFase("STAP 4 — Berichten voor de pitches filteren");
  const berichtenVanVandaag = alleBerichten.filter(binnen);
  console.log(`Voor de pitches: ${berichtenVanVandaag.length} van ${alleBerichten.length} unieke bericht(en) vallen binnen het venster.`);

  // STAP 5 — Splitsen en sorteren
  logFase("STAP 5 — Splitsen en sorteren op datum");
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

  logFase("STAP 6 — Gemini-beoordeling");
  const startGemini = Date.now();

  console.log(`Lokaal: ${Math.min(lokaal.length, DAGCAP_GEMINI)} van ${lokaal.length} berichten gaan naar Gemini.`);
  const lokaalBeoordeeld = await beoordeelBerichten(lokaal, apiKey, DAGCAP_GEMINI, "lokaal");

  console.log(`Landelijk: ${Math.min(landelijk.length, DAGCAP_GEMINI)} van ${landelijk.length} berichten gaan naar Gemini.`);
  const landelijkBeoordeeld = await beoordeelBerichten(landelijk, apiKey, DAGCAP_GEMINI, "landelijk");

  logDuur(startGemini, "Gemini-beoordeling");

  await schrijfJson("nieuws-lokaal.json", lokaalBeoordeeld);
  await schrijfJson("nieuws-landelijk.json", landelijkBeoordeeld);

  logFase("STAP 7 — Pitches samenstellen");
  const kansrijkeLokaal = lokaalBeoordeeld.filter((b) => b.aiBeoordeling?.oppakbaar === "ja");
  const kansrijkLandelijk = landelijkBeoordeeld.filter((b) => b.aiBeoordeling?.lokaleInvalshoek === "ja");

  const topPitches = stelPitchesSamen(kansrijkeLokaal, kansrijkLandelijk, AANTAL_PITCHES);

  await schrijfJson("pitches.json", {
    gegenereerdOp: new Date().toISOString(),
    aantalBerichtenTotaal: berichtenVanVandaag.length,
    topPitches,
  });

  console.log(`Pitches: ${topPitches.length} van ${kansrijkeLokaal.length + kansrijkLandelijk.length} kansrijke bericht(en) opgenomen (top ${AANTAL_PITCHES}).`);

  logDuur(startRun, "Dagelijkse run");
  console.log(`Klaar: ${topPitches.length} pitches gegenereerd.`);
}

main().catch((fout) => {
  console.error(`Dagelijkse run stopte met een fout: ${fout.stack || fout.message}`);
  process.exit(1);
});
