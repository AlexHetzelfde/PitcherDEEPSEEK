// scrapers/ibabs.js
//
// Scraper voor iBabs-rapporten (Collegeberichten, Ingekomen stukken, en elk
// ander iBabs-rapport dat je later toevoegt).
//
// Sinds de "ibabs-kolommen-vast"-ronde (2026-10-22):
//  - De kolomconfiguratie staat per bron in bronnen.js onder `bron.ibabs`.
//    Elk iBabs-rapport heeft een andere kolomvolgorde en sorteert op een
//    andere kolom; één vaste lijst in deze scraper kan dus nooit voor alle
//    rapporten tegelijk werken. Dynamisch uit de HTML lezen kan, maar voegt
//    een extra GET en een parser toe die kan falen. Vast per bron is
//    voorspelbaarder.
//  - parseerNlDatum is geankerd en accepteert zowel ISO (YYYY-MM-DD) als
//    NL (DD-MM-YYYY). Zonder anker matchte "2026-10-22" als 26-10-2022,
//    waardoor alle berichten vier jaar oud leken en werden overgeslagen.
//  - DT_RowId krijgt een eventuele "row_"-prefix gestript voordat er een
//    detailpagina-URL van wordt gemaakt.
//
// Sinds de "ibabs-tekstbron"-ronde (2026-10-17):
//  - voegDocumentInhoudToe zet tekstBron: "artikel" op alle returns waar
//    PDF- of HTML-tekst is toegevoegd. Zonder deze vlag telde de statistiek
//    in index.js de iBabs-items als "lijst", ook al hadden ze volledige
//    PDF-tekst.
//  - Per bericht wordt gelogd welk type tekst is opgehaald.

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

/**
 * Leest de iBabs-configuratie uit bronnen.js. Elke iBabs-bron moet een
 * `ibabs`-object hebben met:
 *   - kolommen: [{ data, searchable? }] in exact de volgorde van de HTML
 *   - sorteerKolom: naam van de kolom waarop gesorteerd wordt
 *   - sorteerRichting: "asc" of "desc" (default "desc")
 *   - datumVelden: lijst van velden waaruit de publicatiedatum wordt gelezen
 *   - samenvattingVelden: lijst van velden die in de samenvatting komen
 *
 * Zonder `ibabs` valt de scraper terug op de Collegeberichten-configuratie
 * en logt een waarschuwing. Zo blijft de scraper werken als je vergeet de
 * configuratie toe te voegen, maar zie je het wel in de log.
 */
function leesIbabsConfig(bron, log = console) {
  const cfg = bron.ibabs;
  if (!cfg || !Array.isArray(cfg.kolommen) || cfg.kolommen.length === 0) {
    log.warn(
      `[${bron.id}] Geen 'ibabs'-configuratie in bronnen.js. De scraper valt terug op de Collegeberichten-configuratie. Voeg 'ibabs: { kolommen, sorteerKolom, ... }' toe aan deze bron.`
    );
    return {
      kolommen: [
        { data: "title", searchable: false },
        { data: "registrationdate" },
        { data: "datumbericht" },
        { data: "portefeuillehouderselectie" },
        { data: "typeselectie", searchable: false },
        { data: "afhandelingselectie" },
      ],
      sorteerKolom: "datumbericht",
      sorteerRichting: "desc",
      datumVelden: ["datumbericht", "registrationdate"],
      samenvattingVelden: ["typeselectie", "portefeuillehouderselectie", "afhandelingselectie"],
    };
  }
  return {
    kolommen: cfg.kolommen,
    sorteerKolom: cfg.sorteerKolom || cfg.kolommen[0].data,
    sorteerRichting: cfg.sorteerRichting === "asc" ? "asc" : "desc",
    datumVelden:
      Array.isArray(cfg.datumVelden) && cfg.datumVelden.length
        ? cfg.datumVelden
        : cfg.kolommen.map((k) => k.data).filter((d) => /datum/i.test(d)),
    samenvattingVelden: Array.isArray(cfg.samenvattingVelden) ? cfg.samenvattingVelden : [],
  };
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
  const config = leesIbabsConfig(bron);

  let cookie = "";
  try {
    const { response: sessieResponse } = await fetchMetTimeout(
      lijstPageUrl,
      { headers: { "User-Agent": GEBRUIKERSAGENT } },
      "text"
    );
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
        body: bouwLijstBody(0, 1, config),
      },
      "json"
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    rijen = data.data || [];
  } catch (fout) {
    console.error(`[${bron.id}] Lijst ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const alleBerichten = rijen
    .map((rij) => normaliseerRij(rij, bron, config))
    .filter((b) => b.titel);

  const zonderDatum = alleBerichten.filter((b) => !b.gepubliceerdOp);
  if (zonderDatum.length > 0) {
    console.warn(
      `[${bron.id}] ${zonderDatum.length} van ${alleBerichten.length} berichten hadden geen herkenbare datum (geprobeerd: ${config.datumVelden.join(", ")}) — die tellen mee als "te oud" en worden overgeslagen.`
    );
    const voorbeelden = rijen
      .filter((rij) => !config.datumVelden.some((veld) => parseerNlDatum(rij[veld])))
      .slice(0, 3);
    for (const rij of voorbeelden) {
      console.warn(`[${bron.id}]   voorbeeld — beschikbare velden: ${Object.keys(rij).join(", ")}`);
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
    console.warn(
      `[${bron.id}] ${zonderInhoud} van ${compleetBerichten.length} bericht(en) zonder documentinhoud — zie de waarschuwingen hierboven voor de reden per bericht.`
    );
  }

  for (const bericht of compleetBerichten) {
    const lengte = (bericht.samenvatting || "").length;
    console.log(
      `[${bron.id}]   "${(bericht.titel || "").slice(0, 60)}": samenvatting ${lengte} tekens, tekstBron=${bericht.tekstBron || "geen"}`
    );
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

/**
 * Bouwt de POST-body voor /Reports/GetReportData. De kolommen, hun volgorde
 * en de sorteerkolom komen uit bron.ibabs (zie bronnen.js). De API verwacht
 * exact dezelfde namen en volgorde als de DataTables-configuratie op de
 * rapportpagina.
 *
 * De `search[value]` per kolom: "|" voor kolommen die doorzoekbaar zijn,
 * "" voor kolommen die dat niet zijn (zoals title). Dat matcht de
 * DataTables-configuratie in de HTML en is wat de oude code ook deed.
 */
function bouwLijstBody(start, draw, config) {
  const params = new URLSearchParams();
  params.set("draw", String(draw));
  config.kolommen.forEach((kol, i) => {
    params.set(`columns[${i}][data]`, kol.data);
    params.set(`columns[${i}][name]`, kol.data);
    params.set(`columns[${i}][searchable]`, kol.searchable === false ? "false" : "true");
    params.set(`columns[${i}][orderable]`, "true");
    params.set(`columns[${i}][search][value]`, kol.searchable === false ? "" : "|");
    params.set(`columns[${i}][search][regex]`, "false");
  });
  const sorteerIdx = config.kolommen.findIndex((k) => k.data === config.sorteerKolom);
  const idx = sorteerIdx >= 0 ? sorteerIdx : 0;
  params.set("order[0][column]", String(idx));
  params.set("order[0][dir]", config.sorteerRichting);
  params.set("order[0][name]", config.kolommen[idx].data);
  params.set("start", String(start));
  params.set("length", String(PAGE_SIZE));
  params.set("search[value]", "");
  params.set("search[regex]", "false");
  return params.toString();
}

function normaliseerRij(rij, bron, config) {
  let gepubliceerdOp = null;
  for (const veld of config.datumVelden) {
    gepubliceerdOp = parseerNlDatum(rij[veld]);
    if (gepubliceerdOp) break;
  }
  const samenvatting = config.samenvattingVelden
    .map((veld) => rij[veld])
    .filter((v) => typeof v === "string" && v.trim())
    .join(" — ");
  const itemId = rij.DT_RowId ? String(rij.DT_RowId).replace(/^row_/, "") : null;
  return {
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: (rij.title || "").trim(),
    itemId,
    url: itemId ? `${BASE_URL}/Reports/Item/${itemId}` : bron.url,
    samenvatting,
    gepubliceerdOp,
    opgehaaldOp: new Date().toISOString(),
  };
}

/**
 * Parseert een datum uit de iBabs-respons. Geankerd, zodat "2026-10-22"
 * niet als 26-10-2022 wordt gelezen. Accepteert ISO (YYYY-MM-DD) en NL
 * (DD-MM-YYYY), met of zonder tijd erachter.
 */
function parseerNlDatum(tekst) {
  if (!tekst) return null;
  const s = String(tekst).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  const nl = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[T ]|$)/);
  if (nl) {
    const d = new Date(Number(nl[3]), Number(nl[2]) - 1, Number(nl[1]));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
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
      new RegExp(
        `/Reports/Document/${itemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?documentId=([a-f0-9-]{36})`,
        "i"
      )
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
 * helemaal geen PDF-bijlage is. Pakt de velden die iBabs altijd toont:
 * Onderwerp, Toelichting, Afzender, Advies.
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
      console.warn(
        `[${bericht.bronId}] PDF niet op te halen voor "${bericht.titel}" (${laatsteFout}) — HTML-fallback gebruikt (${htmlFallback.length} tekens).`
      );
      return {
        ...bericht,
        samenvatting: [bericht.samenvatting, htmlFallback].filter(Boolean).join(" — "),
        documentInhoudOpgehaald: true,
        tekstBron: "artikel",
      };
    }
    console.warn(
      `[${bericht.bronId}] PDF niet op te halen voor "${bericht.titel}": ${laatsteFout} (geprobeerd: ${pdfKandidaten.length} url's).`
    );
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
      console.log(
        `[${bericht.bronId}] PDF-tekst ingekort van ${volledigeTekst.length} naar ${MAX_DOCUMENT_TEKST_LENGTE} tekens voor "${bericht.titel}".`
      );
    }
  } catch (fout) {
    parseFout = fout.message;
  }

  if (parseFout || !documentTekst) {
    const reden = parseFout
      ? `parse mislukt: ${parseFout}`
      : `geen leesbare tekst (${buffer.length} bytes, waarschijnlijk een scan)`;
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

module.exports = {
  scrapeIbabs,
  parseerNlDatum,
  bouwLijstBody,
  normaliseerRij,
  leesIbabsConfig,
};
