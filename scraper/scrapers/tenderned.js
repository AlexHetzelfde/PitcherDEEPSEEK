// scrapers/tenderned.js
//
// Aanbestedingen van de gemeente Zaanstad uit TenderNed, via de publieke,
// anonieme JSON-webservice die tenderned.nl zelf in de browser gebruikt. Geen
// account nodig. Node-port van scrape_tenderned.py uit IbabsLos2; ZANP leest dus
// niets uit IbabsLos2 en IbabsLos2 wordt niet aangepast.
//
// Waarom naast TED: TED bevat alleen publicaties boven de Europese drempel.
// TenderNed is waar Zaanstad zelf publiceert, inclusief nationale procedures en
// opdrachten onder de drempel.
//
// LET OP: dit is geen gedocumenteerde API. TenderNed waarschuwt zelf dat de
// webservice zonder bericht kan wijzigen. Daarom:
//   - elke run logt hoeveel publicaties er kwamen en welke soorten er waren;
//   - een mislukte aanroep geeft een duidelijke foutmelding, geen stille lege lijst;
//   - het eerste bericht van elke run wordt in ruwe vorm gelogd, zodat de velden
//     te controleren zijn.
//
// Twee aanroepen:
//   1. GET /aanbestedendediensten?search=Zaanstad     het interne id van de dienst
//   2. GET /publicaties?aanbestedendeDienstId=<id>    de nieuwste publicaties
//
// Zonder opgeslagen toestand: elke run de nieuwste MAX_PAGINAS pagina's, en
// berichten voor wat van de laatste dagen is. Aankondiging en gunning van één
// procedure worden hier NIET aan elkaar gekoppeld: dat de 'kenmerk'-sleutel dat
// betrouwbaar doet, is niet geverifieerd. De run logt wel hoeveel kenmerken
// meerdere publicaties delen, zodat dat na de eerste runs te beoordelen is.

"use strict";

const { oorzaakTekst, vandaagAmsterdam } = require("../hulpmiddelen");
const R = require("../aanbesteding-regels");

const BASIS_URL = "https://www.tenderned.nl/papi/tenderned-rs-tns/v2";
const PAGE_SIZE = 50;
const MAX_PAGINAS = 2;
const NIEUWS_DAGEN = 2;
const REQUEST_TIMEOUT_MS = 15_000;
const PUBLIEKE_URL = "https://www.tenderned.nl/aankondigingen/overzicht";

const GEBRUIKERSAGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Hulpfuncties (zonder netwerk, daardoor te testen)
// ---------------------------------------------------------------------------

/** Kiest de aanbestedende dienst: bij voorkeur exact "Gemeente <naam>", anders de eerste. */
function kiesDienst(data, naam) {
  const kandidaten = (data && (data.content || data.aanbestedendeDiensten)) || [];
  if (!kandidaten.length) return null;
  const naamVan = (k) => String(k.naam || k.aanbestedendeDienstNaam || "").trim();
  const exact = kandidaten.find((k) => naamVan(k).toLowerCase() === `gemeente ${naam}`.toLowerCase());
  const gekozen = exact || kandidaten[0];
  return {
    id: gekozen.id ?? gekozen.aanbestedendeDienstId ?? null,
    naam: naamVan(gekozen),
    exact: Boolean(exact),
    aantalKandidaten: kandidaten.length,
  };
}

/** Zet één TenderNed-publicatie om. De publieke link is altijd de gewone pagina, niet de API-link. */
function parsePublicatie(p) {
  const id = p.publicatieId ? String(p.publicatieId) : null;
  const typeOmschrijving = (p.typePublicatie && p.typePublicatie.omschrijving) || null;
  const codeOmschrijving = (p.publicatiecode && p.publicatiecode.omschrijving) || null;
  const titel = p.aanbestedingNaam || "";
  return {
    id,
    kenmerk: p.kenmerk || null,
    titel,
    koper: p.opdrachtgeverNaam || null,
    typeOmschrijving,
    codeOmschrijving,
    soort: R.soortVanTenderned({ typeOmschrijving, codeOmschrijving, titel }),
    procedure: (p.procedure && p.procedure.omschrijving) || null,
    typeOpdracht: (p.typeOpdracht && p.typeOpdracht.omschrijving) || null,
    datum: R.dagVan(p.publicatieDatum),
    sluitingsdatum: R.dagVan(p.sluitingsDatum),
    europees: typeof p.europees === "boolean" ? p.europees : null,
    omschrijving: p.opdrachtBeschrijving || null,
    url: id ? `${PUBLIEKE_URL}/${id}` : null,
  };
}

function maakBericht(bron, p, nu) {
  const kop = R.bouwKop(p.soort, p.titel, []);
  return {
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: kop,
    itemId: p.id,
    url: p.url,
    samenvatting: R.bouwSamenvatting({
      soort: p.soort,
      titel: p.titel,
      koper: p.koper,
      sluitingsdatum: p.sluitingsdatum,
      omschrijving: p.omschrijving,
      winnaars: [],
    }),
    gepubliceerdOp: R.middernachtAmsterdam(p.datum),
    opgehaaldOp: nu.toISOString(),
    aanbesteding: {
      bron: "tenderned",
      soort: p.soort,
      typePublicatie: p.typeOmschrijving,
      publicatiecode: p.codeOmschrijving,
      procedure: p.procedure,
      typeOpdracht: p.typeOpdracht,
      naam: R.schoneTitel(p.titel),
      koper: p.koper,
      sluitingsdatum: p.sluitingsdatum,
      publicatienummer: p.id,
      kenmerk: p.kenmerk,
      europees: p.europees,
      tijdlijn: [],
    },
    geenAi: true,
  };
}

// ---------------------------------------------------------------------------
// Netwerk
// ---------------------------------------------------------------------------

async function haalJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": GEBRUIKERSAGENT }, signal: controller.signal });
    const tekst = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${tekst.slice(0, 300)}`);
    return JSON.parse(tekst);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// De scraper
// ---------------------------------------------------------------------------

async function scrapeTenderned(bron) {
  const nu = new Date();
  const vandaag = vandaagAmsterdam();
  const basis = String(bron.url || BASIS_URL).replace(/\/+$/, "");
  const naam = bron.zoeknaam || "Zaanstad";

  let dienst;
  try {
    const data = await haalJson(`${basis}/aanbestedendediensten?${new URLSearchParams({ page: "0", size: "10", search: naam })}`);
    dienst = kiesDienst(data, naam);
  } catch (fout) {
    console.error(`[${bron.id}] Aanbestedende dienst opzoeken mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }
  if (!dienst || dienst.id === null) {
    console.error(`[${bron.id}] Geen aanbestedende dienst gevonden voor "${naam}": is het zoek-endpoint van vorm veranderd?`);
    return [];
  }
  if (!dienst.exact && dienst.aantalKandidaten > 1) {
    console.warn(`[${bron.id}] Meerdere treffers voor "${naam}" zonder exacte match; gekozen: "${dienst.naam}". Controleer of dat klopt.`);
  }

  const ruw = [];
  try {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const data = await haalJson(
        `${basis}/publicaties?${new URLSearchParams({ page: String(pagina), size: String(PAGE_SIZE), aanbestedendeDienstId: String(dienst.id) })}`
      );
      const lijst = Array.isArray(data.content) ? data.content : [];
      if (pagina === 0) console.log(`[${bron.id}] TenderNed: "${dienst.naam}" (id ${dienst.id}), ${data.totalElements ?? "onbekend aantal"} publicatie(s) volgens de API.`);
      ruw.push(...lijst);
      if (lijst.length < PAGE_SIZE || data.last === true) break;
    }
  } catch (fout) {
    console.error(`[${bron.id}] Publicaties ophalen mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }

  const publicaties = ruw.map(parsePublicatie).filter((p) => p.id && p.datum && p.titel);
  const grensDag = new Date(Date.parse(`${vandaag}T12:00:00Z`) - NIEUWS_DAGEN * 86_400_000).toISOString().slice(0, 10);
  const recent = publicaties.filter((p) => p.datum >= grensDag);

  // Voor de beoordeling van 'kenmerk' als koppelsleutel (zie de kop van dit bestand).
  const perKenmerk = new Map();
  for (const p of publicaties) if (p.kenmerk) perKenmerk.set(p.kenmerk, (perKenmerk.get(p.kenmerk) || 0) + 1);
  const gedeeldeKenmerken = [...perKenmerk.values()].filter((n) => n > 1).length;

  const perSoort = {};
  for (const p of publicaties) perSoort[p.soort] = (perSoort[p.soort] || 0) + 1;
  const types = [...new Set(publicaties.map((p) => p.typeOmschrijving).filter(Boolean))];
  console.log(
    `[${bron.id}] ${publicaties.length} publicatie(s) gelezen; soorten: ${Object.entries(perSoort).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}; ` +
      `${gedeeldeKenmerken} kenmerk(en) met meerdere publicaties; ${recent.length} van de laatste ${NIEUWS_DAGEN} dagen.`
  );
  if (types.length) console.log(`[${bron.id}] Soorten publicatie volgens TenderNed: ${types.slice(0, 12).join(" | ")}`);
  if (recent.length) {
    const eerste = ruw.find((r) => String(r.publicatieId) === recent[0].id);
    console.log(`[${bron.id}] RUW eerste nieuwe publicatie: ${JSON.stringify(eerste).slice(0, 1200)}`);
  }

  return recent.map((p) => maakBericht(bron, p, nu));
}

module.exports = {
  scrapeTenderned,
  // voor tests
  kiesDienst,
  parsePublicatie,
  maakBericht,
};
