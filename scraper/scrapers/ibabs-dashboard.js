// scrapers/ibabs-dashboard.js
//
// Scraper voor het blok "Overzichten" op de startpagina (het dashboard) van
// een iBabs-publieksportaal, bijvoorbeeld
// https://vervoerregio.bestuurlijkeinformatie.nl/
//
// WAAROM DIT APART IS VAN scrapers/ibabs.js
// ibabs.js leest een rapport (Reports/Details/<guid>) via een POST met
// kolomnamen die je per rapport moet kennen. Dit blok staat gewoon in de
// HTML van de startpagina: een tabel (#overviewsList) met per rij een titel,
// een soort (Schriftelijke vragen, Aangenomen moties, Toezeggingen) en een
// "Datum wijziging". Eén GET dekt dus alle soorten tegelijk, zonder
// kolomconfiguratie.
//
// WERKING
//  1. Haal bron.url op en lees de rijen uit #overviewsList.
//  2. "Vandaag" en "Gisteren" in de datumkolom worden omgezet naar een echte
//     datum; anders wordt DD-MM-JJJJ gelezen.
//  3. Alleen rijen binnen de leeftijdsgrens (hulpmiddelen.js) krijgen een
//     detailpagina-check. Zo blijft het bij een uurlijkse run bij een paar
//     verzoeken.
//  4. De detailpagina (/Reports/Item/<guid>) levert de velden (Indiener,
//     Portefeuillehouder, Datum vraag, Reactietermijn, Datum antwoord, ...).
//     Elke bijlage die een PDF is wordt uitgelezen (maximaal 2) en komt in de
//     samenvatting. De basis-URL komt uit bron.url, niets staat hard
//     ingebakken.
//
// Het item krijgt de datum van de laatste wijziging. Een antwoord op een oude
// vraag telt dus als nieuw, en dat is hier juist de bedoeling.

const cheerio = require("cheerio");
const { binnenLeeftijdsgrens, vandaagAmsterdam, oorzaakTekst } = require("../hulpmiddelen");

let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch {
  pdfParse = null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TEKST_LENGTE = 15000;
const MAX_PDFS_PER_ITEM = 2;
const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Velden van de detailpagina die we niet in de samenvatting willen.
const OVERSLAAN_LABELS = new Set(["id", "onderwerp", "bijlage(n)", "bijlagen", "bijlage"]);

function schoon(tekst) {
  return String(tekst || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function haalOp(url, lezer = "text") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": GEBRUIKERSAGENT, "Accept-Language": "nl" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} bij ${url}`);
    return lezer === "buffer" ? Buffer.from(await response.arrayBuffer()) : await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Zet "Vandaag", "Gisteren" of DD-MM-JJJJ om naar een ISO-datum (lokale
 * middernacht, hetzelfde als scrapers/ibabs.js). Geeft null als het niet
 * te lezen is.
 */
function parseerDashboardDatum(tekst, vandaag = vandaagAmsterdam()) {
  const s = schoon(tekst).toLowerCase();
  if (!s) return null;

  const dagIso = (jjjjmmdd) => {
    const [j, m, d] = jjjjmmdd.split("-").map(Number);
    const datum = new Date(j, m - 1, d);
    return isNaN(datum.getTime()) ? null : datum.toISOString();
  };

  if (s === "vandaag") return dagIso(vandaag);
  if (s === "gisteren") {
    const d = new Date(vandaag + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return dagIso(d.toISOString().slice(0, 10));
  }

  const nl = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (nl) {
    const datum = new Date(Number(nl[3]), Number(nl[2]) - 1, Number(nl[1]));
    return isNaN(datum.getTime()) ? null : datum.toISOString();
  }
  return null;
}

/**
 * Leest de rijen uit de startpagina. Gooit een fout als de tabel ontbreekt,
 * zodat een veranderde pagina in de log opvalt in plaats van stil leeg te
 * blijven.
 */
function parseerDashboard(html, basisUrl, vandaag = vandaagAmsterdam()) {
  const $ = cheerio.load(html);
  const tabel = $("#overviewsList");
  if (!tabel.length) {
    throw new Error('Tabel "#overviewsList" niet gevonden op de startpagina (is de pagina veranderd?)');
  }

  const items = [];
  tabel.find("tbody tr").each((_, rij) => {
    const $rij = $(rij);
    const link = $rij.find("th a, td a").first();
    const href = link.attr("href") || $rij.attr("data-nav-url");
    const titel = schoon(link.text() || $rij.find("th").first().text());
    if (!href || !titel) return;

    const cellen = $rij.find("td");
    const soort = schoon(cellen.eq(0).text());
    const datumTekst = schoon(cellen.eq(1).text());

    let url;
    try {
      url = new URL(href, basisUrl).toString();
    } catch {
      return;
    }
    const itemId = (url.match(/\/Reports\/Item\/([0-9a-f-]{36})/i) || [])[1] || null;

    items.push({
      titel,
      soort,
      datumTekst,
      gepubliceerdOp: parseerDashboardDatum(datumTekst, vandaag),
      url,
      itemId,
    });
  });
  return items;
}

/**
 * Leest de velden en de bijlagen van een detailpagina.
 * Geeft { velden: [[label, waarde], ...], bijlagen: [{ naam, url }] }.
 */
function parseerDetail(html, basisUrl) {
  const $ = cheerio.load(html);
  const velden = [];
  $("dl dt").each((_, dt) => {
    const label = schoon($(dt).text());
    if (!label || OVERSLAAN_LABELS.has(label.toLowerCase())) return;
    const waarde = schoon($(dt).next("dd").text());
    if (waarde) velden.push([label, waarde]);
  });

  const bijlagen = [];
  const gezien = new Set();
  $('a[href*="/Reports/Document/"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    let url;
    try {
      url = new URL(href, basisUrl).toString();
    } catch {
      return;
    }
    if (gezien.has(url)) return;
    gezien.add(url);
    const kopie = $a.clone();
    kopie.find(".badge, .icon").remove();
    bijlagen.push({ naam: schoon(kopie.text()), url });
  });

  return { velden, bijlagen };
}

async function leesPdfTekst(url) {
  if (!pdfParse) return null;
  const buffer = await haalOp(url, "buffer");
  if (buffer.subarray(0, 4).toString("latin1") !== "%PDF") return null;
  const resultaat = await pdfParse(buffer);
  const tekst = schoon(resultaat && resultaat.text);
  return tekst || null;
}

async function verrijkMetDetail(item, bron) {
  const basis = { ...item };
  try {
    const html = await haalOp(item.url);
    const { velden, bijlagen } = parseerDetail(html, item.url);

    const delen = [];
    if (item.soort) delen.push(`Soort: ${item.soort}.`);
    for (const [label, waarde] of velden) delen.push(`${label}: ${waarde}.`);
    let samenvatting = delen.join(" ");

    let pdfsGelezen = 0;
    for (const bijlage of bijlagen) {
      if (pdfsGelezen >= MAX_PDFS_PER_ITEM) break;
      if (samenvatting.length >= MAX_TEKST_LENGTE) break;
      try {
        const tekst = await leesPdfTekst(bijlage.url);
        if (!tekst) continue;
        const ruimte = MAX_TEKST_LENGTE - samenvatting.length - 100;
        if (ruimte <= 0) break;
        samenvatting += `\n\nBijlage "${bijlage.naam}": ${tekst.slice(0, ruimte)}`;
        pdfsGelezen++;
      } catch (fout) {
        console.warn(`[${bron.id}] PDF "${bijlage.naam}" lezen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
      }
    }

    return {
      ...basis,
      samenvatting: samenvatting.slice(0, MAX_TEKST_LENGTE),
      documentInhoudOpgehaald: true,
      tekstBron: "artikel",
    };
  } catch (fout) {
    console.warn(`[${bron.id}] Detailpagina van "${item.titel}" ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return {
      ...basis,
      samenvatting: item.soort ? `Soort: ${item.soort}.` : "",
      documentInhoudOpgehaald: false,
    };
  }
}

async function scrapeIbabsDashboard(bron) {
  const html = await haalOp(bron.url);
  const rijen = parseerDashboard(html, bron.url);
  console.log(`[${bron.id}] ${rijen.length} rij(en) in het dashboard.`);

  const onleesbaar = rijen.filter((r) => !r.gepubliceerdOp);
  if (onleesbaar.length) {
    console.warn(
      `[${bron.id}] ${onleesbaar.length} rij(en) met onleesbare datum overgeslagen, bijvoorbeeld "${onleesbaar[0].datumTekst}".`
    );
  }

  const recent = rijen.filter((r) => r.gepubliceerdOp && binnenLeeftijdsgrens(r.gepubliceerdOp));
  const berichten = [];
  for (const rij of recent) {
    const verrijkt = await verrijkMetDetail(rij, bron);
    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel: verrijkt.titel,
      itemId: verrijkt.itemId,
      url: verrijkt.url,
      samenvatting: verrijkt.samenvatting,
      gepubliceerdOp: verrijkt.gepubliceerdOp,
      opgehaaldOp: new Date().toISOString(),
      documentInhoudOpgehaald: verrijkt.documentInhoudOpgehaald,
      ...(verrijkt.tekstBron ? { tekstBron: verrijkt.tekstBron } : {}),
    });
  }
  return berichten;
}

module.exports = {
  scrapeIbabsDashboard,
  parseerDashboard,
  parseerDashboardDatum,
  parseerDetail,
};
