// scrapers/ibabs.js
//
// Sinds de "ibabs-tekstbron"-ronde (2026-10-17):
//  - voegDocumentInhoudToe zet nu tekstBron: "artikel" op alle returns waar
//    PDF- of HTML-tekst is toegevoegd. Zonder deze vlag telde de statistiek
//    in index.js de iBabs-items als "lijst", ook al hadden ze volledige
//    PDF-tekst. De tekststap slaat iBabs over (GEEN_TEKSTOPHAAL_TYPES),
//    dus de vlag moet door de scraper zelf worden gezet.
//  - Per bericht wordt gelogd: "PDF-tekst: X tekens" / "HTML-fallback:
//    X tekens" / "geen tekst". Zo is in de log meteen te zien welk bericht
//    welke tekst heeft opgeleverd.
//  - Na de loop volgt een overzichtslog per bericht: samenvatting-lengte
//    en tekstBron.

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

/**
 * Fetch met een timeout die de HELE operatie dekt (headers én body). De
 * AbortController wordt pas opgeruimd als de body-read klaar is.
 * De lezer bepaalt of de body als tekst, JSON of buffer wordt teruggegeven.
 */
async function fetchMetTimeout(url, opties = {}, lezer = "text") {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...opties, signal: controller.signal });
    let body;
    if (lezer === "json") body = await response.json();
    else if (lezer === "buffer") body = Buffer.from(await response.arrayBuffer());
    else body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function scrapeIbabs(bron) {
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
    const { response: sessieResponse } = await fetchMetTimeout(lijstPageUrl, { headers: { "User-Agent": GEBRUIKERSAGENT } }, "text");
    cookie = verzamelCookies(sessieResponse);
  } catch (fout) {
    console.warn(`[${bron.id}] Sessie ophalen mislukt (${fout.message}${oorzaakTekst(fout)}) — doorgaan zonder cookie.`);
  }

  let rijen;
  try {
    const { response, body: data } = await fetchMetTimeout(
      lijstDataUrl,
      {
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
      },
      "json"
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    rijen = data.data || [];
  } catch (fout) {
    console.error(`[${bron.id}] Lijst ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const alleBerichten = rijen.map((rij) => normaliseerRij(rij, bron)).filter((b) => b.titel);

  const zonderDatum = alleBerichten.filter((b) => !b.gepubliceerdOp);
  if (zonderDatum.length > 0) {
    console.warn(
      `[${bron.id}] ${zonderDatum.length} van ${alleBerichten.length} berichten hadden geen herkenbare datum (datumbericht/registrationdate kon niet geparsed worden) — die tellen mee als "te oud" en worden overgeslagen.`
    );
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

  console.log(`[${bron.id}] ${recenteBerichten.length} bericht(en) waarvoor documentinhoud wordt opgehaald.`);

  const compleetBerichten = [];
  let teller = 0;
  for (const bericht of recenteBerichten) {
    teller++;
    const berichtMetInhoud = await voegDocumentInhoudToe(bericht, cookie);
    if (teller % 10 === 0) {
      console.log(`[${bron.id}] documentinhoud opgehaald: ${teller}/${recenteBerichten.length}`);
    }
    compleetBerichten.push(berichtMetInhoud);
  }

  const zonderInhoud = compleetBerichten.filter((b) => !b.documentInhoudOpgehaald).length;
  if (zonderInhoud > 0) {
    console.warn(`[${bron.id}] ${zonderInhoud} van ${compleetBerichten.length} bericht(en) zonder documentinhoud — zie de waarschuwingen hierboven voor de reden per bericht.`);
  }

  // Overzicht per bericht: welk type tekst is opgehaald en hoeveel tekens.
  // Dit maakt in één oogopslag duidelijk waarom de statistiek in index.js
  // eventueel 0/4 zegt: de samenvatting-lengte zegt niets over de vraag of
  // er artikeltekst is toegevoegd.
  for (const bericht of compleetBerichten) {
    const lengte = (bericht.samenvatting || "").length;
    console.log(`[${bron.id}]   "${(bericht.titel || "").slice(0, 60)}": samenvatting ${lengte} tekens, tekstBron=${bericht.tekstBron || "geen"}`);
  }

  return compleetBerichten;
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
    const specifiek = html.match(
      new RegExp(`/Reports/Document/${itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?documentId=([a-f0-9-]{36})`, "i")
    );
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
 * leesbare tekst bevat (bijvoorbeeld een scan zonder tekstlaag) of wanneer er
 * helemaal geen PDF-bijlage is (nieuwsbrieven, externe brieven). Pakt de
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

async function voegDocumentInhoudToe(bericht, cookie) {
  if (!bericht.itemId) {
    console.warn(`[${bericht.bronId}] Geen itemId voor "${bericht.titel}" — detailpagina overgeslagen.`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  const itemUrl = `${BASE_URL}/Reports/Item/${bericht.itemId}`;
  let html;
  try {
    const { response, body } = await fetchMetTimeout(
      itemUrl,
      {
        headers: {
          "User-Agent": GEBRUIKERSAGENT,
          Accept: "text/html",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      "text"
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = body;
  } catch (fout) {
    console.warn(`[${bericht.bronId}] Detailpagina niet op te halen voor "${bericht.titel}": ${fout.message}${oorzaakTekst(fout)}`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  const htmlFallback = haalDetailTekstUitHtml(html);
  const documentId = vindDocumentId(html, bericht.itemId);

  if (!documentId) {
    if (htmlFallback) {
      console.log(`[${bericht.bronId}] HTML-fallback: ${htmlFallback.length} tekens voor "${bericht.titel}".`);
      return {
        ...bericht,
        samenvatting: [bericht.samenvatting, htmlFallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
        tekstBron: "artikel",
      };
    }
    console.warn(`[${bericht.bronId}] Geen documentId én geen HTML-fallback voor "${bericht.titel}" (itemId ${bericht.itemId}).`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

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
      const { response, body: buf } = await fetchMetTimeout(
        kandidaat,
        {
          headers: {
            "User-Agent": GEBRUIKERSAGENT,
            Accept: "application/pdf,*/*",
            Referer: itemUrl,
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        "buffer"
      );
      if (!response.ok) {
        laatsteFout = `HTTP ${response.status}`;
        continue;
      }
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
    if (htmlFallback) {
      console.warn(`[${bericht.bronId}] PDF niet op te halen voor "${bericht.titel}" (${laatsteFout}) — HTML-fallback gebruikt (${htmlFallback.length} tekens).`);
      return {
        ...bericht,
        samenvatting: [bericht.samenvatting, htmlFallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
        tekstBron: "artikel",
      };
    }
    console.warn(`[${bericht.bronId}] PDF niet op te halen voor "${bericht.titel}": ${laatsteFout} (geprobeerd: ${pdfKandidaten.length} url's).`);
    return { ...bericht, documentInhoudOpgehaald: false };
  }

  if (!pdfParse) {
    console.warn(`[${bericht.bronId}] pdf-parse niet beschikbaar — pdf overgeslagen voor "${bericht.titel}".`);
    if (htmlFallback) {
      return {
        ...bericht,
        url: pdfUrl,
        samenvatting: [bericht.samenvatting, htmlFallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
        tekstBron: "artikel",
      };
    }
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

  if (parseFout || !documentTekst) {
    const reden = parseFout ? `parse mislukt: ${parseFout}` : `geen leesbare tekst (${buffer.length} bytes, waarschijnlijk een scan)`;
    console.warn(`[${bericht.bronId}] PDF onbruikbaar voor "${bericht.titel}" (${reden}).`);
    if (htmlFallback) {
      console.log(`[${bericht.bronId}] HTML-fallback: ${htmlFallback.length} tekens voor "${bericht.titel}".`);
      return {
        ...bericht,
        url: pdfUrl,
        samenvatting: [bericht.samenvatting, htmlFallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
        tekstBron: "artikel",
      };
    }
    return { ...bericht, url: pdfUrl, documentInhoudOpgehaald: false };
  }

  console.log(`[${bericht.bronId}] PDF-tekst: ${documentTekst.length} tekens voor "${bericht.titel}".`);
  return {
    ...bericht,
    url: pdfUrl,
    samenvatting: [bericht.samenvatting, documentTekst].filter(Boolean).join(" — "),
    documentInhoudOpgehaald: true,
    tekstBron: "artikel",
  };
}

module.exports = { scrapeIbabs };
