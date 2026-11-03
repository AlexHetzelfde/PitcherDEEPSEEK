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

/**
 * Probeert een URL als PDF te lezen. Geeft { buffer } bij succes, anders
 * { reden } met wat er terugkwam (voor de log).
 */
async function probeerPdf(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": GEBRUIKERSAGENT, "Accept-Language": "nl" },
      signal: controller.signal,
    });
    const type = (response.headers.get("content-type") || "onbekend type").split(";")[0];
    if (!response.ok) return { reden: `HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.subarray(0, 4).toString("latin1") !== "%PDF") return { reden: `geen PDF (${type})` };
    return { buffer };
  } catch (fout) {
    return { reden: fout.name === "AbortError" ? "time-out" : fout.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * De bijlagelink van een Overzichten-item (/Reports/Document/<item>?documentId=)
 * geeft GEEN PDF maar een HTML-pagina met een viewer. Het script dat die viewer
 * laadt (/Script/LoadDocument/<documentId>) bevat het echte adres. Deze functie
 * haalt daar de bruikbare adressen uit.
 */
function adressenUitViewerScript(js, documentId, origin) {
  const gevonden = new Set();
  const letterlijk = /["'`]((?:https?:\/\/[^"'`\s]+)|(?:\/[^"'`\s]+))["'`]/g;
  let m;
  while ((m = letterlijk.exec(js)) !== null) {
    const pad = m[1];
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico)(\?|$)/i.test(pad)) continue;
    if (pad.includes(documentId) || /(document|download|view|pdf|file)/i.test(pad)) {
      try {
        gevonden.add(new URL(pad, origin).toString());
      } catch {
        // geen geldig adres, overslaan
      }
    }
  }
  return [...gevonden].slice(0, 6);
}

/**
 * Haalt de PDF-tekst van een bijlage op. Probeert eerst de bekende adressen
 * en kijkt daarna in het viewer-script. Logt welk adres werkte, of anders
 * per adres waarom het niet lukte, zodat een stille mislukking niet meer kan.
 */
async function leesPdfTekst(bijlage, bronId) {
  if (!pdfParse) {
    console.warn(`[${bronId}] pdf-parse is niet geïnstalleerd, bijlagen worden niet gelezen.`);
    return null;
  }
  const origin = new URL(bijlage.url).origin;
  const documentId = (bijlage.url.match(/documentId=([0-9a-f-]{36})/i) || [])[1] || null;

  const pogingen = [];
  const probeer = async (url) => {
    const uitkomst = await probeerPdf(url);
    pogingen.push(`${url} (${uitkomst.reden || "ok"})`);
    return uitkomst.buffer || null;
  };

  let buffer = await probeer(bijlage.url);
  if (!buffer && documentId) {
    for (const url of [`${origin}/Document/View/${documentId}`, `${origin}/Reports/Document/${documentId}`]) {
      buffer = await probeer(url);
      if (buffer) break;
    }
  }
  if (!buffer && documentId) {
    try {
      const js = await haalOp(`${origin}/Script/LoadDocument/${documentId}`);
      for (const url of adressenUitViewerScript(js, documentId, origin)) {
        if (pogingen.some((p) => p.startsWith(url + " "))) continue;
        buffer = await probeer(url);
        if (buffer) break;
      }
    } catch (fout) {
      pogingen.push(`viewer-script (${fout.message})`);
    }
  }

  if (!buffer) {
    console.warn(`[${bronId}] Geen PDF gevonden voor bijlage "${bijlage.naam}". Geprobeerd: ${pogingen.join("; ")}`);
    return null;
  }
  console.log(`[${bronId}] PDF "${bijlage.naam}" gelezen via ${pogingen[pogingen.length - 1].replace(/ \(ok\)$/, "")}`);

  const resultaat = await pdfParse(buffer);
  const tekst = schoon(resultaat && resultaat.text);
  return tekst || null;
}

/**
 * "Datum antwoord" is voor een AI dubbelzinnig: er kan staan dat het antwoord
 * er al is of nog komt. Daarom zetten we er een duidelijk werkwoord bij.
 */
function antwoordLabel(waarde, vandaag = vandaagAmsterdam()) {
  const iso = parseerDashboardDatum(waarde, vandaag);
  const vandaagIso = parseerDashboardDatum("Vandaag", vandaag);
  if (!iso || !vandaagIso) return "Datum antwoord";
  return iso <= vandaagIso ? "Antwoord al gegeven op" : "Antwoord verwacht op";
}

async function verrijkMetDetail(item, bron) {
  const basis = { ...item };
  try {
    const html = await haalOp(item.url);
    const { velden, bijlagen } = parseerDetail(html, item.url);

    const delen = [];
    if (item.soort) delen.push(`Soort: ${item.soort}.`);
    for (const [label, waarde] of velden) {
      const naam = label.toLowerCase() === "datum antwoord" ? antwoordLabel(waarde) : label;
      delen.push(`${naam}: ${waarde}.`);
    }
    let samenvatting = delen.join(" ");

    let pdfsGelezen = 0;
    for (const bijlage of bijlagen) {
      if (pdfsGelezen >= MAX_PDFS_PER_ITEM) break;
      if (samenvatting.length >= MAX_TEKST_LENGTE) break;
      try {
        const tekst = await leesPdfTekst(bijlage, bron.id);
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
  adressenUitViewerScript,
  antwoordLabel,
};
