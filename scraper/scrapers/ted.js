// scrapers/ted.js
//
// EU-aanbestedingen van de gemeente Zaanstad uit TED (Tenders Electronic
// Daily), via de officiële, anonieme TED Search API:
//
//     POST https://api.ted.europa.eu/v3/notices/search
//
// Node-port van scrape_aanbestedingen.py uit IbabsLos2. ZANP leest dus niets uit
// IbabsLos2 en IbabsLos2 wordt niet aangepast.
//
// Werking per run (zonder opgeslagen toestand: de hele lijst is klein)
//   1. Alle publicaties met "Zaanstad" in de naam van de aanbestedende dienst
//      sinds ~18 maanden, in één tot drie aanroepen van 100.
//   2. Per procedure (procedure-identifier) de publicaties op volgorde: de
//      aankondiging, later de gunning of een wijziging. Dat is de tijdlijn.
//   3. Berichten voor publicaties van de laatste dagen. Elk bericht draagt het
//      veld `aanbesteding` met o.a. die tijdlijn.
//
// Status: zie aanbesteding-regels.js. Een gunningsbericht zonder winnaar en
// zonder bedrag is "afgerond zonder gunning" en NIET "gegund".
//
// Het veld winner-selection-status (eForms BT-142) zou dat nog directer zeggen,
// maar ik kan hier niet testen of de API het kent. Daarom vragen we het eerst
// mee; geeft TED een HTTP 400 (onbekend veld), dan vragen we opnieuw zonder en
// loggen we het antwoord van TED (daar staan de geldige velden in).

"use strict";

const { oorzaakTekst, vandaagAmsterdam } = require("../hulpmiddelen");
const R = require("../aanbesteding-regels");

const TED_URL = "https://api.ted.europa.eu/v3/notices/search";
const TERUGKIJKEN_DAGEN = 540;
const PAGE_LIMIT = 100;
const MAX_PAGINAS = 3;
const MAX_TOTAAL = 2000; // zoveel resultaten voor één gemeente bestaat niet: de query is dan te breed
const NIEUWS_DAGEN = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const TAAL_VOORKEUR = ["nld", "nl", "eng", "en", "fra", "fr", "deu", "de"];

const BASIS_VELDEN = [
  "publication-number",
  "notice-title",
  "notice-type",
  "buyer-name",
  "publication-date",
  "deadline",
  "classification-cpv",
  "estimated-value-lot",
  "tender-value",
  "winner-name",
  "procedure-identifier",
  "notice-identifier",
];
const EXTRA_VELDEN = ["winner-selection-status"];

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Hulpfuncties (zonder netwerk, daardoor te testen)
// ---------------------------------------------------------------------------

/** Eén bruikbare waarde uit een TED-veld: lijst, meertalig object of gewone waarde. */
function plat(waarde) {
  if (waarde === null || waarde === undefined || waarde === "") return null;
  if (Array.isArray(waarde)) {
    for (const w of waarde) {
      const x = plat(w);
      if (x !== null) return x;
    }
    return null;
  }
  if (typeof waarde === "object") {
    for (const taal of TAAL_VOORKEUR) {
      if (taal in waarde) {
        const x = plat(waarde[taal]);
        if (x !== null) return x;
      }
    }
    for (const w of Object.values(waarde)) {
      const x = plat(w);
      if (x !== null) return x;
    }
    return null;
  }
  return waarde;
}

/** Alle verschillende tekstwaarden uit een TED-veld (bijv. meerdere winnaars). */
function alle(waarde, uit = new Set()) {
  if (waarde === null || waarde === undefined || waarde === "") return uit;
  if (Array.isArray(waarde)) waarde.forEach((w) => alle(w, uit));
  else if (typeof waarde === "object") {
    // Meertalig: één taal is genoeg, anders zouden we dezelfde naam meerdere keren tellen.
    const taal = TAAL_VOORKEUR.find((t) => t in waarde) || Object.keys(waarde)[0];
    if (taal !== undefined) alle(waarde[taal], uit);
  } else uit.add(String(waarde).trim());
  return uit;
}

function veld(notice, ...namen) {
  for (const n of namen) {
    if (n in notice) {
      const x = plat(notice[n]);
      if (x !== null) return x;
    }
  }
  return null;
}

function getal(waarde) {
  const n = Number(plat(waarde));
  return Number.isFinite(n) ? n : null;
}

/** Zet één TED-resultaat om in een publicatie. */
function parseNotice(notice) {
  const nummer = veld(notice, "publication-number", "notice-identifier");
  const titel = veld(notice, "notice-title") || "";
  const noticeType = veld(notice, "notice-type");
  const winnaars = [...alle(notice["winner-name"])].filter(Boolean);
  const gegundeWaarde = getal(notice["tender-value"]);
  const geraamdeWaarde = getal(notice["estimated-value-lot"]);
  const selectie = veld(notice, "winner-selection-status");
  // "clos-nw" (gesloten, geen winnaar) is de eForms-code voor een perceel zonder gunning.
  const geenWinnaarGemeld = String(selectie || "").toLowerCase() === "clos-nw";
  const soort = R.soortVanTed({
    noticeType,
    titel,
    heeftWinnaar: winnaars.length > 0 && !geenWinnaarGemeld,
    heeftBedrag: gegundeWaarde !== null && gegundeWaarde > 0 && !geenWinnaarGemeld,
  });
  const datum = R.dagVan(veld(notice, "publication-date"));
  return {
    nummer,
    procedureId: veld(notice, "procedure-identifier"),
    noticeType,
    soort,
    titel,
    koper: veld(notice, "buyer-name"),
    datum,
    sluitingsdatum: R.dagVan(veld(notice, "deadline")),
    cpv: veld(notice, "classification-cpv"),
    geraamdeWaarde,
    gegundeWaarde,
    winnaars,
    url: nummer ? `https://ted.europa.eu/nl/notice/-/detail/${nummer}` : null,
  };
}

/** Groepeert publicaties per procedure, op volgorde van datum. Zonder procedure-id staat een publicatie alleen. */
function groepeerPerProcedure(publicaties) {
  const groepen = new Map();
  for (const p of publicaties) {
    const sleutel = p.procedureId || `los:${p.nummer}`;
    if (!groepen.has(sleutel)) groepen.set(sleutel, []);
    groepen.get(sleutel).push(p);
  }
  for (const lijst of groepen.values()) {
    lijst.sort((a, b) => String(a.datum || "").localeCompare(String(b.datum || "")) || String(a.nummer).localeCompare(String(b.nummer)));
  }
  return groepen;
}

function tijdlijnVan(lijst) {
  return lijst.map((p) => ({ datum: p.datum, soort: p.soort, nummer: p.nummer, url: p.url }));
}

/** Het bericht voor één publicatie, met de tijdlijn van de hele procedure. */
function maakBericht(bron, publicatie, procedureLijst, nu) {
  const kop = R.bouwKop(publicatie.soort, publicatie.titel, publicatie.winnaars);
  const gegeven = {
    soort: publicatie.soort,
    titel: publicatie.titel,
    koper: publicatie.koper,
    geraamdeWaarde: publicatie.geraamdeWaarde,
    gegundeWaarde: publicatie.gegundeWaarde,
    winnaars: publicatie.winnaars,
    sluitingsdatum: publicatie.sluitingsdatum,
  };
  return {
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: kop,
    itemId: publicatie.nummer,
    url: publicatie.url,
    samenvatting: R.bouwSamenvatting(gegeven),
    gepubliceerdOp: R.middernachtAmsterdam(publicatie.datum),
    opgehaaldOp: nu.toISOString(),
    aanbesteding: {
      bron: "ted",
      soort: publicatie.soort,
      noticeType: publicatie.noticeType,
      naam: R.schoneTitel(publicatie.titel),
      koper: publicatie.koper,
      cpv: publicatie.cpv,
      geraamdeWaarde: publicatie.geraamdeWaarde,
      gegundeWaarde: publicatie.gegundeWaarde,
      winnaars: publicatie.winnaars,
      sluitingsdatum: publicatie.sluitingsdatum,
      publicatienummer: publicatie.nummer,
      procedureId: publicatie.procedureId,
      europees: true,
      tijdlijn: tijdlijnVan(procedureLijst),
    },
    geenAi: true,
  };
}

// ---------------------------------------------------------------------------
// Netwerk
// ---------------------------------------------------------------------------

async function zoek(query, velden, pagina) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(TED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": GEBRUIKERSAGENT },
      body: JSON.stringify({
        query,
        fields: velden,
        limit: PAGE_LIMIT,
        scope: "ALL",
        checkQuerySyntax: false,
        paginationMode: "PAGE_NUMBER",
        page: pagina,
      }),
      signal: controller.signal,
    });
    const tekst = await response.text();
    if (!response.ok) {
      const fout = new Error(`HTTP ${response.status}: ${tekst.slice(0, 600)}`);
      fout.status = response.status;
      throw fout;
    }
    return JSON.parse(tekst);
  } finally {
    clearTimeout(timer);
  }
}

async function haalAlleNotices(bron, query) {
  let velden = [...BASIS_VELDEN, ...EXTRA_VELDEN];
  const notices = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    let data;
    try {
      data = await zoek(query, velden, pagina);
    } catch (fout) {
      if (fout.status === 400 && velden.length > BASIS_VELDEN.length) {
        console.warn(`[${bron.id}] TED kent een extra veld niet (${fout.message}); opnieuw zonder ${EXTRA_VELDEN.join(", ")}.`);
        velden = [...BASIS_VELDEN];
        data = await zoek(query, velden, pagina);
      } else {
        throw fout;
      }
    }
    const lijst = data.notices || data.results || [];
    if (pagina === 1) {
      const totaal = data.totalNoticeCount ?? data.total ?? null;
      console.log(`[${bron.id}] TED: ${totaal ?? "onbekend aantal"} publicatie(s) volgens de API; velden in het eerste resultaat: ${lijst[0] ? Object.keys(lijst[0]).sort().join(", ") : "(geen)"}`);
      if (typeof totaal === "number" && totaal > MAX_TOTAAL) {
        throw new Error(`Onverwacht veel resultaten (${totaal}) voor één gemeente: de query is vermoedelijk te breed. Afgebroken.`);
      }
    }
    notices.push(...lijst);
    if (lijst.length < PAGE_LIMIT) break;
  }
  return notices;
}

// ---------------------------------------------------------------------------
// De scraper
// ---------------------------------------------------------------------------

async function scrapeTed(bron) {
  const nu = new Date();
  const vandaag = vandaagAmsterdam();
  const vanafDatum = new Date(Date.parse(`${vandaag}T12:00:00Z`) - TERUGKIJKEN_DAGEN * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const naam = bron.zoeknaam || "Zaanstad";
  const query = `buyer-name~"${naam}" AND PD>=${vanafDatum} SORT BY publication-date DESC`;

  let notices;
  try {
    notices = await haalAlleNotices(bron, query);
  } catch (fout) {
    console.error(`[${bron.id}] TED ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const publicaties = notices.map(parseNotice).filter((p) => p.nummer && p.datum);
  const groepen = groepeerPerProcedure(publicaties);
  const zonderProcedure = publicaties.filter((p) => !p.procedureId).length;

  const grensDag = new Date(Date.parse(`${vandaag}T12:00:00Z`) - NIEUWS_DAGEN * 86_400_000).toISOString().slice(0, 10);
  const berichten = [];
  for (const lijst of groepen.values()) {
    for (const p of lijst) {
      if (p.datum >= grensDag) berichten.push(maakBericht(bron, p, lijst, nu));
    }
  }

  const perSoort = {};
  for (const p of publicaties) perSoort[p.soort] = (perSoort[p.soort] || 0) + 1;
  console.log(
    `[${bron.id}] ${publicaties.length} publicatie(s) in ${groepen.size} procedure(s)` +
      `${zonderProcedure ? `, ${zonderProcedure} zonder procedure-id` : ""}; ` +
      `soorten: ${Object.entries(perSoort).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}; ` +
      `${berichten.length} bericht(en) van de laatste ${NIEUWS_DAGEN} dagen.`
  );
  return berichten;
}

module.exports = {
  scrapeTed,
  // voor tests
  plat,
  alle,
  parseNotice,
  groepeerPerProcedure,
  maakBericht,
};
