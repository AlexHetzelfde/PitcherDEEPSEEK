// scrapers/moties.js
//
// Moties van de gemeenteraad van Zaanstad, rechtstreeks uit iBabs, voor de
// nieuwstab "Gemeente" van ZANP. Een motie komt pas in de stroom als er over
// gestemd is (aangenomen of verworpen). Zonder stemming, ingetrokken of
// aangehouden: niet.
//
// Dit is een Node-port van de motie-logica uit IbabsLos2 (scrape_moties.py).
// ZANP leest dus NIET de gegevens van IbabsLos2 en IbabsLos2 wordt niet
// aangepast: beide halen zelf op bij iBabs.
//
// Werking per run
//   1. Lijst: POST /Reports/GetReportData/{rapport-id} (zelfde aanroep als
//      IbabsLos2), alleen moties met een vergaderdatum van de laatste
//      MOTIE_VENSTER_DAGEN dagen.
//   2. Per motie de detailpagina /Reports/Item/{id}: uitslag, percentage voor,
//      fracties voor en tegen, agendapunt.
//   3. Alleen bij een uitslag: de PDF-bijlage, daaruit de strekking (zie
//      moties-tekst.js, zonder AI).
//   4. Moties die al met strekking in data/berichten.json staan worden
//      overgeslagen: ze hoeven niet elk uur opnieuw opgehaald.
//
// Elk bericht krijgt de velden:
//   stemming   { uitslag, voorPct, tegenPct, fractiesVoor[], fractiesTegen[],
//                indiener, fracties[], medeondertekenaars[], vergaderdatum,
//                vergadering, agendapunt, type, code }
//   strekking  { tekst, aanleiding, bron }   (bron: dictum | begin | toelichting | geen)
//   vasteRubriek "GEM", geenAi true
// wire.js zet die op het berichtrecord (de pop-up toont ze).
//
// De eerste runs loggen de ruwe uitslagtekst van de eerste moties, zodat te
// controleren is of de pagina nog zo in elkaar zit als verwacht.

"use strict";

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { knipStrekking } = require("./moties-tekst");
const { oorzaakTekst } = require("../hulpmiddelen");

let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch {
  pdfParse = null;
}

// Zelfde map als gedeeld.js (hier niet geïmporteerd: gedeeld.js laadt het register, dat deze scraper).
const DATA_MAP = process.env.ZANP_DATA_DIR || path.join(__dirname, "..", "..", "data");

const BASE_URL = "https://zaanstad.bestuurlijkeinformatie.nl";
const PAGE_SIZE = 100;
const MAX_PAGINAS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MOTIE_VENSTER_DAGEN = 7; // een motie telt mee tot 7 dagen na de vergaderdatum
const REGISTRATIE_MARGE_DAGEN = 45; // de lijst is gesorteerd op aanmaakdatum; zo ver terug kijken we
const PARALLEL = 4;
const START_BUDGET_MS = 24_000; // daarna geen nieuwe motie meer beginnen (ZANP breekt een bron af na 45 s)
const MAX_PDF_BYTES = 4_000_000;
const MAX_RUWE_LOGS = 2;
const TOEGESTANE_TYPES = ["motie"]; // amendementen bewust niet

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Kolommen van het rapport "Moties en amendementen": zelfde volgorde en
// zoekwaarden als in IbabsLos2 (MOTIES_COLUMNS). [naam, heeftPijpInZoekveld]
const KOLOMMEN = [
  ["typeselectie", false],
  ["title", false],
  ["datummotie", true],
  ["raadsledenselectie", true],
  ["fractieselectie", true],
  ["medeondertekenaarsselectie", true],
  ["registrationdate", true],
];
const SORTEER_KOLOM = 6; // registrationdate, aflopend

// ---------------------------------------------------------------------------
// Hulpfuncties (zonder netwerk, daardoor te testen)
// ---------------------------------------------------------------------------

/** "10-11-2026" of "2026-11-10" → "2026-11-10", anders null. */
function parseDatum(tekst) {
  const s = String(tekst || "").trim();
  const nl = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (nl) return `${nl[3]}-${nl[2].padStart(2, "0")}-${nl[1].padStart(2, "0")}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

function dagenGeleden(dagIso, nu = new Date()) {
  if (!dagIso) return null;
  const d = Date.parse(`${dagIso}T12:00:00Z`);
  if (isNaN(d)) return null;
  const vandaag = Date.parse(`${nu.toISOString().slice(0, 10)}T12:00:00Z`);
  return Math.round((vandaag - d) / 86_400_000);
}

function lijstUitTekst(tekst) {
  return String(tekst || "")
    .split(/\r?\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Zet de uitslagtekst van iBabs om in "aangenomen" | "verworpen" | "ingetrokken" | "aangehouden" | null. */
function uitslagVanTekst(tekst) {
  const t = String(tekst || "").toLowerCase();
  if (!t.trim()) return null;
  if (/ingetrokken/.test(t)) return "ingetrokken";
  if (/aangehouden|uitgesteld|doorgeschoven/.test(t)) return "aangehouden";
  if (/verworpen/.test(t)) return "verworpen";
  if (/aangenomen|overgenomen/.test(t)) return "aangenomen";
  return null;
}

/**
 * Leest de detailpagina van een motie. Het eerste deel is de port van
 * fetch_stemming_detail uit IbabsLos2 (zelfde regexen voor de stemming), het
 * tweede deel leest de overige velden met cheerio.
 */
function leesDetailHtml(html) {
  const uit = { uitslagTekst: "", uitslag: null, voorPct: null, tegenPct: null, fractiesVoor: [], fractiesTegen: [] };

  const m = html.match(/<dt[^>]*>\s*Uitslag\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  if (m) {
    uit.uitslagTekst = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    uit.uitslag = uitslagVanTekst(uit.uitslagTekst);
  }

  const pct = html.match(/vote-summary-bar-in-favour\s+w-(\d+)/);
  if (pct) {
    uit.voorPct = Number(pct[1]);
    uit.tegenPct = 100 - uit.voorPct;
  }
  // Valt de uitslagtekst weg maar is het percentage er wel, dan is de uitslag
  // eenduidig, behalve bij precies 50/50 (staken).
  if (!uit.uitslag && uit.voorPct !== null && uit.voorPct !== 50) {
    uit.uitslag = uit.voorPct > 50 ? "aangenomen" : "verworpen";
  }

  const legenda = (soort) => {
    const r = html.match(new RegExp(`vote-summary-legend-${soort}[^>]*>[\\s\\S]*?<div class="text">\\s*([^<]+?)\\s*</div>`, "i"));
    return r
      ? r[1]
          .replace(/&amp;/g, "&")
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  };
  uit.fractiesVoor = legenda("in-favour");
  uit.fractiesTegen = legenda("against");

  // Overige velden: <dt>Naam</dt><dd>…</dd>
  const $ = cheerio.load(html);
  const velden = {};
  $("dt").each((_, dt) => {
    const naam = $(dt).text().replace(/\s+/g, " ").trim().toLowerCase();
    const dd = $(dt).next("dd");
    if (!naam || !dd.length) return;
    velden[naam] = dd;
  });
  const tekstVan = (naam) => (velden[naam] ? velden[naam].text().replace(/\s+/g, " ").trim() : "");
  uit.toelichting = tekstVan("toelichting");

  const ap = velden["agendapunt"];
  if (ap && ap.length) {
    const vergadering = ap.find(".strong").first().text().replace(/\s+/g, " ").trim();
    const volledig = ap.text().replace(/\s+/g, " ").trim();
    const punt = volledig.match(/\(([^)]+)\)/);
    uit.vergadering = vergadering || null;
    uit.agendapunt = punt ? punt[1].trim() : null;
  }

  const dd = velden["bijlage(s)"];
  const documentId =
    (html.match(/documentId=([a-f0-9-]{36})/i) || [])[1] || (html.match(/data-document-id=["']([a-f0-9-]{36})["']/i) || [])[1] || null;
  uit.documentId = documentId;
  uit.heeftBijlage = Boolean(dd && dd.find("a").length);
  return uit;
}

/** Bouwt de rij uit het rapport om tot een motie-object. */
function parseRij(rij) {
  const titel = String(rij.title || "").trim();
  let type = String(rij.typeselectie || "").trim();
  if (!type) type = /\b26A|\bAmendement/i.test(titel) ? "Amendement" : "Motie";
  const code = (titel.match(/^(\d{2}[A-Z]\d+)\b/) || [])[1] || null;
  const naam = titel.replace(/^\d{2}[A-Z]\d+\s+/i, "").replace(/^(?:motie|amendement)\s+/i, "").trim() || titel;
  return {
    id: rij.DT_RowId ? String(rij.DT_RowId).replace(/^row_/, "") : null,
    titel,
    naam,
    code,
    type,
    datum: parseDatum(rij.datummotie),
    registratie: parseDatum(rij.registrationdate),
    indiener: String(rij.raadsledenselectie || "").trim() || null,
    fracties: lijstUitTekst(rij.fractieselectie),
    medeondertekenaars: lijstUitTekst(rij.medeondertekenaarsselectie),
  };
}

function bouwKop(motie, uitslag) {
  const werkwoord = uitslag === "aangenomen" ? "aangenomen" : "verworpen";
  return `Motie ${werkwoord}: ${motie.naam}`;
}

function bouwSamenvatting(motie, stemming, strekking) {
  const delen = [`Motie ${motie.code || ""} ${motie.naam}.`.replace(/\s+/g, " ")];
  const indienend = [motie.indiener, motie.fracties.length ? `(${motie.fracties.join(", ")})` : ""].filter(Boolean).join(" ");
  if (indienend) delen.push(`Ingediend door ${indienend}.`);
  const pct = stemming.voorPct !== null ? ` met ${stemming.voorPct}% voor` : "";
  delen.push(`Uitslag: ${stemming.uitslag}${pct}.`);
  if (stemming.fractiesVoor.length) delen.push(`Voor: ${stemming.fractiesVoor.join(", ")}.`);
  if (stemming.fractiesTegen.length) delen.push(`Tegen: ${stemming.fractiesTegen.join(", ")}.`);
  if (strekking.aanleiding) delen.push(strekking.aanleiding);
  if (strekking.tekst) delen.push(strekking.tekst);
  return delen.join(" ");
}

// ---------------------------------------------------------------------------
// Netwerk
// ---------------------------------------------------------------------------

async function fetchMetTimeout(url, opties = {}, lezer = "text") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...opties, signal: controller.signal });
    let body;
    if (lezer === "json") body = await response.json();
    else if (lezer === "buffer") body = Buffer.from(await response.arrayBuffer());
    else body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timer);
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
  const p = new URLSearchParams();
  p.set("draw", String(draw));
  KOLOMMEN.forEach(([naam, pijp], i) => {
    p.set(`columns[${i}][data]`, naam);
    p.set(`columns[${i}][name]`, naam);
    p.set(`columns[${i}][searchable]`, "true");
    p.set(`columns[${i}][orderable]`, "true");
    p.set(`columns[${i}][search][value]`, pijp ? "|" : "");
    p.set(`columns[${i}][search][regex]`, "false");
  });
  p.set("order[0][column]", String(SORTEER_KOLOM));
  p.set("order[0][dir]", "desc");
  p.set("order[0][name]", KOLOMMEN[SORTEER_KOLOM][0]);
  p.set("start", String(start));
  p.set("length", String(PAGE_SIZE));
  p.set("search[value]", "");
  p.set("search[regex]", "false");
  return p.toString();
}

/** Moties die al met strekking in berichten.json staan: die slaan we over. */
function bekendeMoties(berichtenPad) {
  const bekend = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(berichtenPad, "utf8"));
    for (const r of Array.isArray(data.berichten) ? data.berichten : []) {
      if (r && r.url && r.stemming && r.strekking && r.strekking.tekst) bekend.add(r.url);
    }
  } catch {
    // geen bestand of kapot: dan is niets bekend en halen we alles op
  }
  return bekend;
}

async function haalPdfTekst(motie, documentId, cookie, bronId) {
  if (!pdfParse) {
    console.warn(`[${bronId}] pdf-parse niet beschikbaar; PDF van "${motie.titel}" overgeslagen.`);
    return "";
  }
  const itemUrl = `${BASE_URL}/Reports/Item/${motie.id}`;
  const kandidaten = [
    `${BASE_URL}/Reports/Document/${motie.id}?documentId=${documentId}`,
    `${BASE_URL}/Document/View/${documentId}`,
    `${BASE_URL}/Reports/Document/${documentId}`,
  ];
  let laatste = null;
  for (const url of kandidaten) {
    try {
      const { response, body } = await fetchMetTimeout(
        url,
        { headers: { "User-Agent": GEBRUIKERSAGENT, Accept: "application/pdf,*/*", Referer: itemUrl, ...(cookie ? { Cookie: cookie } : {}) } },
        "buffer"
      );
      if (!response.ok) {
        laatste = `HTTP ${response.status}`;
        continue;
      }
      if (body.subarray(0, 4).toString() !== "%PDF") {
        laatste = "geen PDF-header";
        continue;
      }
      if (body.length > MAX_PDF_BYTES) {
        laatste = `PDF te groot (${body.length} bytes)`;
        break;
      }
      const data = await pdfParse(body);
      return data.text || "";
    } catch (fout) {
      laatste = `${fout.message}${oorzaakTekst(fout)}`;
    }
  }
  console.warn(`[${bronId}] PDF van "${motie.titel}" niet te lezen: ${laatste}.`);
  return "";
}

// ---------------------------------------------------------------------------
// De scraper
// ---------------------------------------------------------------------------

async function scrapeMoties(bron) {
  const start = Date.now();
  const nu = new Date();
  const guid = (String(bron.url || "").match(/Reports\/Details\/([a-f0-9-]{36})/i) || [])[1];
  if (!guid) {
    console.warn(`[${bron.id}] Geen rapport-id in de url: ${bron.url}`);
    return [];
  }
  const lijstPagina = bron.url;
  const lijstData = `${BASE_URL}/Reports/GetReportData/${guid}`;

  let cookie = "";
  try {
    const { response } = await fetchMetTimeout(lijstPagina, { headers: { "User-Agent": GEBRUIKERSAGENT } }, "text");
    cookie = verzamelCookies(response);
  } catch (fout) {
    console.warn(`[${bron.id}] Sessie ophalen mislukt (${fout.message}${oorzaakTekst(fout)}); doorgaan zonder cookie.`);
  }

  // 1. De lijst, nieuwste aanmaakdatum eerst, met vroege stop.
  const rijen = [];
  try {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const { response, body } = await fetchMetTimeout(
        lijstData,
        {
          method: "POST",
          headers: {
            "User-Agent": GEBRUIKERSAGENT,
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Origin: BASE_URL,
            Referer: lijstPagina,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: bouwLijstBody(pagina * PAGE_SIZE, pagina + 1),
        },
        "json"
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Array.isArray(body.data) ? body.data : [];
      rijen.push(...data);
      const totaal = Number(body.recordsTotal) || 0;
      const allemaalOud =
        data.length > 0 &&
        data.every((r) => {
          const d = dagenGeleden(parseDatum(r.registrationdate), nu);
          return d !== null && d > MOTIE_VENSTER_DAGEN + REGISTRATIE_MARGE_DAGEN;
        });
      if (allemaalOud || (pagina + 1) * PAGE_SIZE >= totaal || data.length === 0) break;
    }
  } catch (fout) {
    console.error(`[${bron.id}] Lijst ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const moties = rijen.map(parseRij).filter((m) => m.id && m.titel);
  const stats = { lijst: moties.length, buitenVenster: 0, amendement: 0, bekend: 0, zonderUitslag: 0, nietGestemd: 0, mislukt: 0, nieuw: 0 };

  const inVenster = [];
  for (const m of moties) {
    const d = dagenGeleden(m.datum, nu);
    if (d === null || d < -1 || d > MOTIE_VENSTER_DAGEN) {
      stats.buitenVenster++;
      continue;
    }
    if (!TOEGESTANE_TYPES.includes(m.type.toLowerCase())) {
      stats.amendement++;
      continue;
    }
    inVenster.push(m);
  }

  const bekend = bekendeMoties(path.join(DATA_MAP, "berichten.json"));
  const teDoen = inVenster.filter((m) => {
    if (bekend.has(`${BASE_URL}/Reports/Item/${m.id}`)) {
      stats.bekend++;
      return false;
    }
    return true;
  });
  teDoen.sort((a, b) => (b.datum || "").localeCompare(a.datum || ""));

  // 2 en 3. Detail, uitslag, strekking: vier tegelijk.
  const resultaat = [];
  let ruweLogs = 0;
  let volgende = 0;

  async function verwerk(motie) {
    const itemUrl = `${BASE_URL}/Reports/Item/${motie.id}`;
    let html;
    try {
      const { response, body } = await fetchMetTimeout(
        itemUrl,
        { headers: { "User-Agent": GEBRUIKERSAGENT, Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) } },
        "text"
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = body;
    } catch (fout) {
      stats.mislukt++;
      console.warn(`[${bron.id}] Detailpagina van "${motie.titel}" niet op te halen: ${fout.message}${oorzaakTekst(fout)}`);
      return;
    }

    const detail = leesDetailHtml(html);
    if (!detail.uitslag) {
      stats.zonderUitslag++;
      return;
    }
    if (detail.uitslag !== "aangenomen" && detail.uitslag !== "verworpen") {
      stats.nietGestemd++; // ingetrokken, aangehouden
      return;
    }
    if (ruweLogs < MAX_RUWE_LOGS) {
      ruweLogs++;
      console.log(
        `[${bron.id}] RUW "${motie.titel}": uitslag="${detail.uitslagTekst}" voor=${detail.voorPct}% ` +
          `fracties voor=[${detail.fractiesVoor.join(", ")}] tegen=[${detail.fractiesTegen.join(", ")}] ` +
          `bijlage=${detail.heeftBijlage} documentId=${detail.documentId || "geen"} agendapunt="${detail.agendapunt || ""}"`
      );
    }

    // De strekking: PDF, anders de toelichting op de pagina.
    let strekking = { strekking: "", aanleiding: null, bron: "geen" };
    if (detail.documentId) {
      const pdfTekst = await haalPdfTekst(motie, detail.documentId, cookie, bron.id);
      if (pdfTekst) strekking = knipStrekking(pdfTekst, motie.titel);
    }
    if (!strekking.strekking && detail.toelichting) {
      const t = knipStrekking(detail.toelichting, motie.titel);
      if (t.strekking) strekking = { ...t, bron: "toelichting" };
    }
    if (!strekking.strekking) {
      console.warn(`[${bron.id}] Geen strekking gevonden voor "${motie.titel}" (de motie komt er wel in, zonder strekking).`);
    }

    const stemming = {
      uitslag: detail.uitslag,
      voorPct: detail.voorPct,
      tegenPct: detail.tegenPct,
      fractiesVoor: detail.fractiesVoor,
      fractiesTegen: detail.fractiesTegen,
      indiener: motie.indiener,
      fracties: motie.fracties,
      medeondertekenaars: motie.medeondertekenaars,
      vergaderdatum: motie.datum,
      vergadering: detail.vergadering || null,
      agendapunt: detail.agendapunt || null,
      type: motie.type,
      code: motie.code,
    };

    stats.nieuw++;
    resultaat.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel: bouwKop(motie, detail.uitslag),
      itemId: motie.id,
      url: itemUrl,
      samenvatting: bouwSamenvatting(motie, stemming, { aanleiding: strekking.aanleiding, tekst: strekking.strekking }),
      // Het moment waarop ZANP de stemming zag; een motie wordt pas nieuws als er gestemd is.
      gepubliceerdOp: nu.toISOString(),
      opgehaaldOp: nu.toISOString(),
      stemming,
      strekking: { tekst: strekking.strekking, aanleiding: strekking.aanleiding, bron: strekking.bron },
      vasteRubriek: "GEM",
      geenAi: true,
    });
  }

  async function werker() {
    while (volgende < teDoen.length) {
      if (Date.now() - start > START_BUDGET_MS) return;
      const motie = teDoen[volgende++];
      await verwerk(motie);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, teDoen.length) }, werker));

  const overgeslagenDoorTijd = Math.max(0, teDoen.length - volgende);
  console.log(
    `[${bron.id}] ${stats.lijst} in het rapport, ${inVenster.length} motie(s) in het venster van ${MOTIE_VENSTER_DAGEN} dagen ` +
      `(${stats.buitenVenster} buiten het venster, ${stats.amendement} amendement), ${stats.bekend} al bekend. ` +
      `Nu: ${stats.nieuw} met stemming, ${stats.zonderUitslag} zonder uitslag, ${stats.nietGestemd} ingetrokken/aangehouden, ${stats.mislukt} mislukt` +
      `${overgeslagenDoorTijd ? `, ${overgeslagenDoorTijd} voor de volgende run (tijdbudget)` : ""}.`
  );
  return resultaat;
}

module.exports = {
  scrapeMoties,
  // voor tests
  parseDatum,
  uitslagVanTekst,
  leesDetailHtml,
  parseRij,
  bouwKop,
  bouwSamenvatting,
  bouwLijstBody,
};
