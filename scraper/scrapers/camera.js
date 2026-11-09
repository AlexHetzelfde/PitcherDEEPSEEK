// scrapers/camera.js
//
// Cameratoezicht in Zaanstad, rechtstreeks uit officielebekendmakingen.nl, voor
// ZANP. Node-port van het cameradeel van scrape_besluiten.py uit IbabsLos2; ZANP
// leest dus niets uit IbabsLos2 en IbabsLos2 wordt niet aangepast.
//
// Werking per run
//   1. De RSS-feed (bron.url) ophalen; alleen items met "cameratoezicht" in de
//      beschrijving, gepubliceerd vanaf CAMERA_VANAF.
//   2. Elk besluit dat nog niet bekend is: de besluitpagina ophalen en de
//      metavelden lezen (OVERHEIDop.startdatum en einddatum, DC.title), het
//      "Camera: <naam>"-label en de aanleiding ("Overwegende dat"). Hooguit
//      MAX_NIEUW_PER_RUN per run; de rest volgt de volgende run.
//   3. Alle bekende besluiten tot reeksen verbinden (camera-reeks.js).
//   4. Opslaan in data/zanp-camera/:
//        besluiten.json   wat al opgehaald is (zodat een besluit maar één keer
//                         wordt opgehaald)
//        reeksen.json     de reeksen, voor de rode regel, de agenda en de pop-up
//      Beide bestanden zijn deterministisch (geen tijdstempel): zonder nieuwe
//      besluiten verandert er niets en komt er geen extra commit.
//   5. Berichten teruggeven voor besluiten van de laatste dagen. Een bericht
//      draagt het veld `camera`; wire.js zet dat op het record.
//
// Het bericht gaat niet langs de AI (geenAi), zodat een aanleiding als
// "schietincident" geen alert uitlokt: de aanleiding staat in de pop-up.

"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { oorzaakTekst, kalenderdagAmsterdam, vandaagAmsterdam } = require("../hulpmiddelen");
const { bouwReeksen, locatieNaam, plaatsUit, soortVanTitel, volgendeDagVan } = require("../camera-reeks");

// Zelfde map als gedeeld.js (hier niet geïmporteerd: gedeeld.js laadt het register, dat deze scraper).
const DATA_MAP = process.env.ZANP_DATA_DIR || path.join(__dirname, "..", "..", "data");
const CAMERA_MAP = path.join(DATA_MAP, "zanp-camera");

const CAMERA_VANAF = "2026-07-01"; // zelfde startdatum als IbabsLos2
const MAX_NIEUW_PER_RUN = 8;
const MAX_POGINGEN = 3;
const REQUEST_TIMEOUT_MS = 12_000;
const START_BUDGET_MS = 28_000; // ZANP breekt een bron na 45 s af
const PAUZE_MS = 400;
const NIEUWS_DAGEN = 2; // besluiten van de laatste dagen worden bericht (het venster van ZANP beslist verder)

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Keyword-indeling van de aanleiding, zoals in IbabsLos2. Een term mag in
// meerdere categorieën voorkomen.
const REDEN_KEYWORDS = {
  "Wapens/schietincident": ["vuurwapen", "wapen", "wapens", "schietincident", "beschoten", "kogelgaten", "geschoten"],
  Steekincident: ["steekincident", "gestoken", "mes"],
  Drugs: ["drugs", "verdovende middelen", "drugshandel", "drugsoverlast"],
  Overlast: ["overlast", "wanordelijkheden", "onrust"],
  "Geweld/bedreiging": ["geweld", "bedreiging", "mishandeling"],
  "Brand/explosie": ["brand", "explosie", "explosief"],
  Ondermijning: ["ondermijning", "criminele activiteit", "criminaliteit"],
};

// ---------------------------------------------------------------------------
// Hulpfuncties (zonder netwerk, daardoor te testen)
// ---------------------------------------------------------------------------

function isoDatum(tekst) {
  const s = String(tekst || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}` ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

function overwegendeBlok(platteTekst) {
  const m = platteTekst.match(/overwegende\s+dat[:\s]*([\s\S]*?)(?:gelet\s+op\b|besluit\s*:)/i);
  return m ? m[1] : platteTekst;
}

function classificeerReden(blok) {
  const t = blok.toLowerCase();
  return Object.entries(REDEN_KEYWORDS)
    .filter(([, woorden]) => woorden.some((w) => t.includes(w)))
    .map(([categorie]) => categorie);
}

function redenSamenvatting(blok, categorieen) {
  if (!categorieen.length) return null;
  const woorden = categorieen.flatMap((c) => REDEN_KEYWORDS[c]);
  const fragmenten = blok.split(/[•\n]|(?<=[.;])\s+(?=[A-Z])/);
  for (const f of fragmenten) {
    const s = f.replace(/\s+/g, " ").trim();
    if (s && woorden.some((w) => s.toLowerCase().includes(w))) return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  }
  return null;
}

/**
 * Leest een besluitpagina. Geeft null als start of einddatum ontbreekt: dan is
 * het geen bruikbaar besluit (wordt een paar keer opnieuw geprobeerd).
 */
function leesBesluitHtml(html, link) {
  const $ = cheerio.load(html);
  const meta = (naam) => {
    const el = $("meta").filter((_, e) => ($(e).attr("name") || $(e).attr("property")) === naam).first();
    return el.length ? el.attr("content") : undefined;
  };
  const start = isoDatum(meta("OVERHEIDop.startdatum"));
  const eind = isoDatum(meta("OVERHEIDop.einddatum"));
  const titel = (meta("DC.title") || "").trim();
  if (!start || !eind) return null;

  // "Camera: <naam>" als losse alinea, anders in de platte tekst.
  let label = null;
  $("p").each((_, p) => {
    const m = $(p).text().match(/^\s*Camera\s*:\s*(.+?)\s*$/i);
    if (m && !label) label = m[1].trim();
  });
  const platte = $.root().text().replace(/[ \t]+/g, " ");
  if (!label) {
    const m = platte.match(/Camera\s*:\s*([^\n]+)/i);
    if (m) label = m[1].trim();
  }
  if (!label) label = locatieNaam("", titel) || titel || link;

  const blok = overwegendeBlok(platte);
  const categorieen = classificeerReden(blok);
  return {
    url: link,
    titel,
    camera: label,
    plaats: plaatsUit(titel) || plaatsUit(label),
    soort: soortVanTitel(titel),
    start,
    eind,
    redenCategorieen: categorieen,
    redenSamenvatting: redenSamenvatting(blok, categorieen),
  };
}

/** Haalt items uit de RSS-feed (RSS 2.0, met een Atom-terugval). */
function leesFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $("item").each((_, el) => {
    items.push({
      beschrijving: $(el).children("description").text().trim(),
      link: $(el).children("link").text().trim(),
      pubdate: $(el).children("pubDate").text().trim(),
    });
  });
  if (!items.length) {
    $("entry").each((_, el) => {
      items.push({
        beschrijving: ($(el).children("summary").text() || $(el).children("content").text()).trim(),
        link: $(el).children("link").attr("href") || "",
        pubdate: ($(el).children("published").text() || $(el).children("updated").text()).trim(),
      });
    });
  }
  return items.map((i) => {
    const t = Date.parse(i.pubdate);
    return { ...i, pubdateIso: Number.isNaN(t) ? null : new Date(t).toISOString() };
  });
}

function bouwSamenvatting(b) {
  const delen = [`${b.titel}.`];
  delen.push(`Locatie: ${b.camera}${b.plaats ? `, ${b.plaats}` : ""}.`);
  delen.push(`Periode: ${b.start} t/m ${b.eind}.`);
  if (b.redenSamenvatting) delen.push(`Aanleiding: ${b.redenSamenvatting}`);
  else if (b.redenCategorieen.length) delen.push(`Aanleiding: ${b.redenCategorieen.join(", ")}.`);
  return delen.join(" ");
}

// ---------------------------------------------------------------------------
// Netwerk en bestanden
// ---------------------------------------------------------------------------

async function haalTekst(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": GEBRUIKERSAGENT }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function leesJsonBestand(pad, standaard) {
  try {
    return JSON.parse(fs.readFileSync(pad, "utf8"));
  } catch {
    return standaard;
  }
}

// Schrijft alleen als de inhoud verandert, zodat een run zonder nieuws geen commit uitlokt.
function schrijfAlsAnders(pad, data) {
  const tekst = `${JSON.stringify(data, null, 2)}\n`;
  try {
    if (fs.readFileSync(pad, "utf8") === tekst) return false;
  } catch {
    // bestand bestaat nog niet
  }
  fs.mkdirSync(path.dirname(pad), { recursive: true });
  fs.writeFileSync(pad, tekst, "utf8");
  return true;
}

const pauze = (ms) => new Promise((klaar) => setTimeout(klaar, ms));

// ---------------------------------------------------------------------------
// De scraper
// ---------------------------------------------------------------------------

async function scrapeCamera(bron) {
  const start = Date.now();
  const vandaag = vandaagAmsterdam();

  const besluitenPad = path.join(CAMERA_MAP, "besluiten.json");
  const reeksenPad = path.join(CAMERA_MAP, "reeksen.json");
  const staat = leesJsonBestand(besluitenPad, { besluiten: {}, mislukt: {} });
  const besluiten = staat.besluiten && typeof staat.besluiten === "object" ? staat.besluiten : {};
  const mislukt = staat.mislukt && typeof staat.mislukt === "object" ? staat.mislukt : {};

  let feed = [];
  try {
    feed = leesFeed(await haalTekst(bron.url));
  } catch (fout) {
    console.error(`[${bron.id}] RSS-feed ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
  }
  const cameraItems = feed.filter(
    (i) => i.link && /cameratoezicht/i.test(i.beschrijving) && (kalenderdagAmsterdam(i.pubdateIso) || "9999-99-99") >= CAMERA_VANAF
  );

  const pubdatePerLink = {};
  for (const i of cameraItems) pubdatePerLink[i.link] = i.pubdateIso;

  const nieuw = cameraItems.filter((i) => !besluiten[i.link] && (mislukt[i.link] || 0) < MAX_POGINGEN);
  let opgehaald = 0;
  let nietBruikbaar = 0;
  for (const item of nieuw.slice(0, MAX_NIEUW_PER_RUN)) {
    if (Date.now() - start > START_BUDGET_MS) break;
    try {
      const b = leesBesluitHtml(await haalTekst(item.link), item.link);
      if (!b) {
        mislukt[item.link] = (mislukt[item.link] || 0) + 1;
        nietBruikbaar++;
        console.warn(`[${bron.id}] Geen start- of einddatum in ${item.link} (poging ${mislukt[item.link]} van ${MAX_POGINGEN}).`);
      } else if (b.start < CAMERA_VANAF && b.eind < CAMERA_VANAF) {
        mislukt[item.link] = MAX_POGINGEN; // volledig voor de startdatum: nooit meer proberen
      } else {
        besluiten[item.link] = { ...b, pubdate: kalenderdagAmsterdam(item.pubdateIso) || null };
        opgehaald++;
      }
    } catch (fout) {
      mislukt[item.link] = (mislukt[item.link] || 0) + 1;
      console.warn(`[${bron.id}] Besluitpagina ${item.link} niet op te halen: ${fout.message}${oorzaakTekst(fout)}`);
    }
    await pauze(PAUZE_MS);
  }

  const reeksen = bouwReeksen(Object.values(besluiten));
  try {
    const gesorteerd = Object.fromEntries(Object.entries(besluiten).sort(([a], [b]) => a.localeCompare(b)));
    const mislukteGesorteerd = Object.fromEntries(Object.entries(mislukt).sort(([a], [b]) => a.localeCompare(b)));
    const a = schrijfAlsAnders(besluitenPad, { besluiten: gesorteerd, mislukt: mislukteGesorteerd });
    const b = schrijfAlsAnders(reeksenPad, { reeksen });
    if (a || b) console.log(`[${bron.id}] Cameragegevens bijgewerkt in data/zanp-camera/.`);
  } catch (fout) {
    console.error(`[${bron.id}] Cameragegevens opslaan mislukte: ${fout.message}`);
  }

  // Berichten: besluiten van de laatste dagen.
  const grensDag = volgendeDagVan(vandaag, -NIEUWS_DAGEN);
  const berichten = [];
  for (const b of Object.values(besluiten)) {
    const gepubliceerd = pubdatePerLink[b.url] || b.pubdate;
    const dag = kalenderdagAmsterdam(gepubliceerd);
    if (!dag || dag < grensDag) continue;
    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel: b.titel,
      itemId: null,
      url: b.url,
      samenvatting: bouwSamenvatting(b),
      gepubliceerdOp: gepubliceerd,
      opgehaaldOp: new Date().toISOString(),
      camera: {
        soort: b.soort,
        locatie: locatieNaam(b.camera, b.titel),
        plaats: b.plaats,
        start: b.start,
        eind: b.eind,
        redenCategorieen: b.redenCategorieen,
        redenSamenvatting: b.redenSamenvatting,
      },
      geenAi: true,
    });
  }

  console.log(
    `[${bron.id}] ${feed.length} item(s) in de feed, ${cameraItems.length} over cameratoezicht; ` +
      `${opgehaald} nieuw opgehaald${nietBruikbaar ? `, ${nietBruikbaar} onbruikbaar` : ""}` +
      `${nieuw.length > MAX_NIEUW_PER_RUN ? `, ${nieuw.length - Math.min(nieuw.length, MAX_NIEUW_PER_RUN)} voor de volgende run` : ""}; ` +
      `${Object.keys(besluiten).length} besluiten in ${reeksen.length} reeks(en); ${berichten.length} bericht(en) van de laatste ${NIEUWS_DAGEN} dagen.`
  );
  return berichten;
}

module.exports = {
  scrapeCamera,
  // voor tests
  leesBesluitHtml,
  leesFeed,
  isoDatum,
  classificeerReden,
  redenSamenvatting,
  overwegendeBlok,
  bouwSamenvatting,
};
