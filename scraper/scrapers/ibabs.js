// scrapers/ibabs.js
//
// Haalt raadsinformatie op uit iBabs (*.bestuurlijkeinformatie.nl) via de
// onderliggende DataTables-API van de rapportpagina, in plaats van de pagina
// zelf met een browser te laten renderen. Deze aanpak — inclusief de
// tussenstap om via de detailpagina eerst de documentId te vinden voordat de
// pdf gedownload kan worden — is overgenomen uit een al werkend Python-
// scraper-script voor hetzelfde iBabs-systeem. Vereist GEEN Playwright/browser.
//
// BELANGRIJK VOOR SNELHEID: het ophalen van de volledige documentinhoud (een
// extra pagina-load + pdf-download per bericht) is duur. Daarom wordt dat
// alleen gedaan voor berichten die (a) niet ouder zijn dan MAX_LEEFTIJD_DAGEN
// en (b) nog niet eerder gezien zijn (via de gezieneUrls-set die index.js
// meegeeft). Zonder die twee filters zou elke dagelijkse run opnieuw de
// documentinhoud van alle ~100 berichten per rapport ophalen, ook van
// berichten die al weken geleden al eens verwerkt zijn — dat duurde in de
// praktijk 30+ minuten voor niets.
//
// Sinds de "documentinhoud"-ronde (2026-10-13):
//  - Meerdere PDF-URL-patronen worden geprobeerd, inclusief
//    /Reports/Document/{itemId}?documentId={documentId} — het patroon dat
//    de iBabs-detailpagina zelf gebruikt. Het oude /Document/View/{documentId}
//    werkt niet meer op alle iBabs-versies.
//  - Meerdere regex-patronen voor het documentId (inclusief data-document-id).
//  - Elke faalstap logt nu een waarschuwing: geen stil falen meer.
//  - Fallback naar de HTML-tekst van de detailpagina (Onderwerp, Toelichting,
//    Afzender, Advies) als de PDF geen leesbare tekst bevat (bijv. een scan).

const MAX_DOCUMENT_TEKST_LENGTE = 15000;
const REQUEST_TIMEOUT_MS = 15_000;

const { binnenLeeftijdsgrens, MAX_LEEFTIJD_DAGEN, oorzaakTekst } = require("../hulpmiddelen");

let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch {
  pdfParse = null;
}

const BASE_URL = "https://zaanstad.bestuurlijkeinformatie.nl";
const PAGE_SIZE = 100;

const KOLOMMEN = [
  ["title", false],
  ["datumbericht", true],
  ["portefeuillehouderselectie", true],
  ["typeselectie", true],
  ["afhandelingselectie", true],
  ["registrationdate", true],
  ["datum", true],
  ["datumpublicatie", true],
];

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function scrapeIbabs(bron, gezieneUrls = new Set()) {
  const guidMatch = bron.url.match(/Reports\/Details\/([a-f0-9-]{36})/i);
  if (!guidMatch) {
    console.warn(`[${bron.id}] Kon geen rapport-GUID uit de URL halen: ${bron.url}`);
    return [];
  }
  const guid = guidMatch[1];
  const lijstPageUrl = bron.url;
  const lijstDataUrl = `${BASE_URL}/Reports/GetReportData/${guid}`;

  let cookie = "";
  try {
    const sessieResponse = await fetchMetTimeout(lijstPageUrl, { headers: { "User-Agent": GEBRUIKERSAGENT } });
    cookie = verzamelCookies(sessieResponse);
  } catch (fout) {
    console.warn(`[${bron.id}] Sessie ophalen mislukt (${fout.message}${oorzaakTekst(fout)}) — doorgaan zonder cookie.`);
  }

  let rijen;
  try {
    const response = await fetchMetTimeout(lijstDataUrl, {
      method: "POST",
      headers: {
        "User-Agent": GEBRUIKERSAGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE_URL,
        Referer: lijstPageUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: bouwLijstBody(0, 1),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    rijen = data.data || [];
  } catch (fout) {
    console.error(`[${bron.id}] Lijst ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const alleBerichten = rijen.map((rij) => normaliseerRij(rij, bron)).filter((b) => b.titel);

  const zonderDatum = alleBerichten.filter((b) => !b.gepubliceerdOp);
  if (zonderDatum.length > 0) {
    console.warn(`[${bron.id}] ${zonderDatum.length} van ${alleBerichten.length} berichten hadden geen herkenbare datum (datumbericht/registrationdate kon niet geparsed worden) — die tellen mee als "te oud" en worden overgeslagen.`);
    const voorbeelden = rijen
      .filter((rij) => !parseerNlDatum(rij.datumbericht) && !parseerNlDatum(rij.registrationdate))
      .slice(0, 3);
    for (const rij of voorbeelden) {
      console.warn(
        `[${bron.id}]   voorbeeld — datumbericht: ${JSON.stringify(rij.datumbericht)}, registrationdate: ${JSON.stringify(rij.registrationdate)}, alle velden: ${Object.keys(rij).join(", ")}`
      );
    }
  }

  const recenteBerichten = alleBerichten.filter((b) => binnenLeeftijdsgrens(b.gepubliceerdOp));
  const aantalTeOud = alleBerichten.length - recenteBerichten.length;
  if (aantalTeOud > 0) {
    console.log(`[${bron.id}] ${aantalTeOud} bericht(en) ouder dan ${MAX_LEEFTIJD_DAGEN} dagen overgeslagen.`);
  }

  const nieuweBerichten = recenteBerichten.filter((b) => !gezieneUrls.has(b.url));
  const aantalAlGezien = recenteBerichten.length - nieuweBerichten.length;
  if (aantalAlGezien > 0) {
    console.log(`[${bron.id}] ${aantalAlGezien} al eerder gezien bericht(en) overgeslagen (geen nieuwe documentinhoud nodig).`);
  }

  console.log(`[${bron.id}] ${nieuweBerichten.length} bericht(en) waarvoor documentinhoud wordt opgehaald.`);

  const compleetBerichten = [];
  let teller = 0;
  for (const bericht of nieuweBerichten) {
    teller++;
    const berichtMetInhoud = await voegDocumentInhoudToe(bericht, cookie);
    if (teller % 10 === 0) {
      console.log(`[${bron.id}] documentinhoud opgehaald: ${teller}/${nieuweBerichten.length}`);
    }
    compleetBerichten.push(berichtMetInhoud);
  }

  const zonderInhoud = compleetBerichten.filter((b) => !b.documentInhoudOpgehaald).length;
  if (zonderInhoud > 0) {
    console.warn(`[${bron.id}] ${zonderInhoud} van ${compleetBerichten.length} bericht(en) zonder documentinhoud — zie de waarschuwingen hierboven voor de reden per bericht.`);
  }

  return compleetBerichten;
}

async function fetchMetTimeout(url, opties = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opties, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function verzamelCookies(response) {
  const ruw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return ruw.map((c) => c.split(";")[0]).join("; ");
}

function bouwLijstBody(start, draw) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  KOLOMMEN.forEach(([naam, heeftPipe], i) => {
    params.set(`columns[${i}][data]`, naam);
    params.set(`columns[${i}][name]`, naam);
    params.set(`columns[${i}][searchable]`, "true");
    params.set(`columns[${i}][orderable]`, "true");
    params.set(`columns[${i}][search][value]`, heeftPipe ? "|" : "");
    params.set(`columns[${i}][search][regex]`, "false");
  });
  params.set("order[0][column]", "5");
  params.set("order[0][dir]", "desc");
  params.set("order[0][name]", "registrationdate");
  params.set("start", String(start));
  params.set("length", String(PAGE_SIZE));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  return params.toString();
}

function normaliseerRij(rij, bron) {
  return {
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: (rij.title || "").trim(),
    itemId: rij.DT_RowId,
    url: rij.DT_RowId ? `${BASE_URL}/Reports/Item/${rij.DT_RowId}` : bron.url,
    samenvatting: [rij.typeselectie, rij.portefeuillehouderselectie, rij.afhandelingselectie]
      .filter(Boolean)
      .join(" — "),
    gepubliceerdOp:
      parseerNlDatum(rij.datumbericht) ||
      parseerNlDatum(rij.datumpublicatie) ||
      parseerNlDatum(rij.datum) ||
      parseerNlDatum(rij.registrationdate),
    opgehaaldOp: new Date().toISOString(),
  };
}

function parseerNlDatum(tekst) {
  if (!tekst) return null;
  const match = String(tekst).match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!match) return null;
  const [, dag, maand, jaar] = match;
  const datum = new Date(Number(jaar), Number(maand) - 1, Number(dag));
  return isNaN(datum.getTime()) ? null : datum.toISOString();
}

/**
 * Zoekt het documentId in de detailpagina-HTML. Drie patronen, want
 * iBabs-versies en pagina-varianten verschillen:
 *   1. /Reports/Document/{itemId}?documentId={uuid}
 *   2. documentId={uuid}         (losse parameter, overal in de HTML)
 *   3. data-document-id="{uuid}" (attribuut op de bijlage-link)
 */
function vindDocumentId(html, itemId) {
  if (itemId) {
    const specifiek = html.match(new RegExp(`/Reports/Document/${itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?documentId=([a-f0-9-]{36})`, "i"));
    if (specifiek) return specifiek[1];
  }
  const los = html.match(/documentId=([a-f0-9-]{36})/i);
  if (los) return los[1];
  const attr = html.match(/data-document-id=["']([a-f0-9-]{36})["']/i);
  if (attr) return attr[1];
  return null;
}

/**
 * Tekst uit de detailpagina-HTML halen als fallback wanneer de PDF geen
 * leesbare tekst bevat (bijvoorbeeld een scan zonder tekstlaag). Pakt de
 * velden die iBabs altijd toont: Onderwerp, Toelichting, Afzender, Advies.
 */
function haalDetailTekstUitHtml(html) {
  const velden = ["Onderwerp", "Toelichting", "Afzender", "Advies"];
  const stukken = [];
  for (const veld of velden) {
    const regex = new RegExp(`<dt[^>]*>\\s*${veld}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i");
    const match = html.match(regex);
    if (!match) continue;
    const tekst = match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (tekst && !stukken.some((s) => s.endsWith(tekst))) stukken.push(`${veld}: ${tekst}`);
  }
  return stukken.length > 0 ? stukken.join(" — ").slice(0, MAX_DOCUMENT_TEKST_LENGTE) : null;
}

/**
 * Volgt dezelfde tweestapsroute als het werkende Python-script: eerst de
 * detailpagina van het item ophalen om de documentId te vinden, dan pas de
 * pdf zelf downloaden. Meerdere PDF-URL-patronen worden geprobeerd, want
 * /Document/View/ werkt niet meer op alle iBabs-versies. Elke faalstap logt
 * een waarschuwing, zodat in de run te zien is waaróm een bericht geen
 * documentinhoud heeft.
 */
async function voegDocumentInhoudToe(bericht, cookie) {
  if (!bericht.itemId) {
    console.warn(`[${bericht.bronId}] Geen itemId voor "${bericht.titel}" — detailpagina overgeslagen.`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  const itemUrl = `${BASE_URL}/Reports/Item/${bericht.itemId}`;
  let html;
  try {
    const itemResponse = await fetchMetTimeout(itemUrl, {
      headers: {
        "User-Agent": GEBRUIKERSAGENT,
        Accept: "text/html",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!itemResponse.ok) throw new Error(`HTTP ${itemResponse.status}`);
    html = await itemResponse.text();
  } catch (fout) {
    console.warn(`[${bericht.bronId}] Detailpagina niet op te halen voor "${bericht.titel}": ${fout.message}${oorzaakTekst(fout)}`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  const documentId = vindDocumentId(html, bericht.itemId);
  if (!documentId) {
    console.warn(`[${bericht.bronId}] Geen documentId in de detailpagina voor "${bericht.titel}" (itemId ${bericht.itemId}).`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  // Meerdere PDF-URL-patronen. De eerste is wat de detailpagina zelf gebruikt;
  // de tweede is het oudere /Document/View/-endpoint dat op sommige
  // iBabs-versies nog werkt; de derde is een variant zonder itemId.
  const pdfKandidaten = [
    `${BASE_URL}/Reports/Document/${bericht.itemId}?documentId=${documentId}`,
    `${BASE_URL}/Document/View/${documentId}`,
    `${BASE_URL}/Reports/Document/${documentId}`,
  ];

  let buffer = null;
  let pdfUrl = null;
  let laatsteFout = null;
  for (const kandidaat of pdfKandidaten) {
    try {
      const pdfResponse = await fetchMetTimeout(kandidaat, {
        headers: {
          "User-Agent": GEBRUIKERSAGENT,
          Accept: "application/pdf,*/*",
          Referer: itemUrl,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!pdfResponse.ok) {
        laatsteFout = `HTTP ${pdfResponse.status}`;
        continue;
      }
      const buf = Buffer.from(await pdfResponse.arrayBuffer());
      if (buf.subarray(0, 4).toString() === "%PDF") {
        buffer = buf;
        pdfUrl = kandidaat;
        break;
      }
      laatsteFout = `geen PDF-header (kreeg "${buf.subarray(0, 8).toString().replace(/\s/g, " ")}")`;
    } catch (fout) {
      laatsteFout = fout.message;
    }
  }

  if (!buffer) {
    console.warn(`[${bericht.bronId}] PDF niet op te halen voor "${bericht.titel}": ${laatsteFout} (geprobeerd: ${pdfKandidaten.length} url's).`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  if (!pdfParse) {
    console.warn(`[${bericht.bronId}] pdf-parse niet beschikbaar — pdf overgeslagen voor "${bericht.titel}".`);
    return { ...bericht, url: pdfUrl, documentInhoudOpgehaald: false };
  }

  let documentTekst = "";
  let parseFout = null;
  try {
    const data = await pdfParse(buffer);
    const volledigeTekst = (data.text || "").replace(/\s+/g, " ").trim();
    documentTekst = volledigeTekst.slice(0, MAX_DOCUMENT_TEKST_LENGTE);
    if (volledigeTekst.length > MAX_DOCUMENT_TEKST_LENGTE) {
      console.log(`[${bericht.bronId}] PDF-tekst ingekort van ${volledigeTekst.length} naar ${MAX_DOCUMENT_TEKST_LENGTE} tekens voor "${bericht.titel}".`);
    }
  } catch (fout) {
    parseFout = fout.message;
  }

  if (parseFout) {
    console.warn(`[${bericht.bronId}] PDF-parse mislukte voor "${bericht.titel}": ${parseFout} (${buffer.length} bytes).`);
    const fallback = haalDetailTekstUitHtml(html);
    if (fallback) {
      return {
        ...bericht,
        url: pdfUrl,
        samenvatting: [bericht.samenvatting, fallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
      };
    }
    return { ...bericht, url: pdfUrl, documentInhoudOpgehaald: false };
  }

  if (!documentTekst) {
    console.warn(`[${bericht.bronId}] PDF bevat geen leesbare tekst voor "${bericht.titel}" (${buffer.length} bytes, waarschijnlijk een scan zonder tekstlaag).`);
    const fallback = haalDetailTekstUitHtml(html);
    if (fallback) {
      console.log(`[${bericht.bronId}] Teruggevallen op de HTML-tekst van de detailpagina voor "${bericht.titel}".`);
      return {
        ...bericht,
        url: pdfUrl,
        samenvatting: [bericht.samenvatting, fallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
      };
    }
    return { ...bericht, url: pdfUrl, documentInhoudOpgehaald: false };
  }

  return {
    ...bericht,
    url: pdfUrl,
    samenvatting: [bericht.samenvatting, documentTekst].filter(Boolean).join(" — "),
    documentInhoudOpgehaald: true,
  };
}

module.exports = { scrapeIbabs };
