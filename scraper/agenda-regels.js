// agenda-regels.js
//
// ZANP-fase 2 (2026-10-24). Alles wat de agenda met WOORDEN en DATUMS doet,
// zonder AI en zonder netwerk. Hier pas je de woordenlijsten aan.
//
// 1. Het agendafilter "eerste keer of jubileum" (beoordeelAgendaRelevantie).
//    Een evenement is alleen interessant als het voor het eerst plaatsvindt
//    of een jubileum is, herkenbaar aan zulke woorden in titel of tekst.
//    Leeftijden ("4 - 10 jaar", "vanaf 6 jaar") tellen niet mee: die gaven in
//    een test op echte data valse treffers. Het filter geldt alleen voor
//    bronnen met agendaFilter "eerste-of-jubileum" in rubrieken.json.
//    Verander je de lijsten hieronder, verhoog dan REGEL_VERSIE: alle
//    opgeslagen beoordelingen worden dan eenmalig opnieuw gedaan.
//
// 2. Datums uit tekst (datumUitTekst). De AI levert alleen de letterlijke
//    datumtekst uit de bron ("dinsdag 3 november", "morgen"). Hier wordt die
//    omgerekend naar een kalenderdag, met een controle op de weekdag.
//
// 3. Termijnen uit bekendmakingen (termijnenUitTekst): zienswijzen, bezwaar,
//    beroep en inspraak met een einddatum worden agendapunten.
//
// 4. Titelgelijkenis (titelGelijkenis), om hetzelfde evenement uit twee
//    bronnen niet dubbel in de agenda te zetten.
//
// Sinds 2026-10-26:
//  - Jubileumfilter uitgebreid met expliciete getallen (10, 20, ... 150, 200).
//  - REGEL_VERSIE verhoogd.
//
// Sinds 2026-10-28:
//  - Jubileumjaren zijn nu alle veelvouden van 5 vanaf 10 ("10 jaar", "20 jaar",
//    "25 jaar", "150 jaar") plus 12,5 jaar. Leeftijden blijven buiten beschouwing,
//    ook als er "kinderen van 10 jaar" of "leeftijd 10 jaar" staat.
//  - vindDatumTekst haalt een datum letterlijk uit een zin (voor patronen.js).
//  - REGEL_VERSIE verhoogd: alle opgeslagen beoordelingen worden eenmalig
//    opnieuw gedaan, zodat bijvoorbeeld "150 jaar Noordzeekanaal" alsnog door
//    het filter komt.
//  - "voor/van/tot N jaar" telt alleen als leeftijd bij 1 t/m 17 jaar, zodat
//    "Feest voor 30 jaar buurthuis" wel een jubileum is.

const REGEL_VERSIE = "2026-10-28-1";

const MAANDEN = {
  januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, augustus: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const WEEKDAGEN = { zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6 };

const MAAND_PATROON = Object.keys(MAANDEN).sort((a, b) => b.length - a.length).join("|");
const WEEKDAG_PATROON = Object.keys(WEEKDAGEN).join("|");

const LEEFTIJD = /\(?\b\d{1,2}\s*[-–]\s*\d{1,2}\s*jaar\b\)?|\b(?:vanaf|van|t\/m|tot|v\.a\.|voor)\s*(?:[1-9]|1[0-7])\s*jaar\b|\b\d{1,2}\s*jaar\s*(?:en ouder|\+|of ouder)/gi;

const EERSTE_KEER = /\b(?:voor het eerst|eerste keer|eerste editie|1e editie|eerste maal|primeur|premi[eè]re|debuut|debuteert|unicum|nooit eerder)\b/i;

const JUBILEUM = new RegExp(
  [
    "\\bjubile\\w+",
    "\\blustrum\\b",
    "\\b\\d{1,3}[- ]?jarig(?:e)?\\s+(?:bestaan|jubileum)",
    "\\bjarig bestaan\\b",
    "\\b\\d{1,3}\\s*jaar\\s+(?:bestaan|geleden|sinds|na)\\b",
    "\\b(?:viert|vieren|bestaat)\\b[^.]{0,30}\\b\\d{1,3}\\s*jaar\\b",
    "\\bherdenk\\w+",
    "\\bverjaardag\\b",
    "\\bsterfdag\\b",
  ].join("|"),
  "i"
);

// "10 jaar", "20 jaar", "25 jaar", "150 jaar": een rond getal voor "jaar" is een
// jubileum, tenzij het een leeftijd is. Leeftijden met een streepje of "vanaf"
// zijn al weggehaald (LEEFTIJD); hier sluiten we ook "kinderen van 10 jaar",
// "leeftijd 10 jaar" en "10 jaar oud" uit.
const RONDE_JAREN = /(?<![\d,.])(\d{1,3}(?:,5)?)\s*jaar\b(?!\s*(?:oud|en ouder|of ouder|\+))/gi;
const LEEFTIJD_CONTEXT = /\b(?:kinderen|kind|jongeren|jeugd|leeftijd|leeftijden|groep|peuters|kleuters|tieners|vanaf|vanaf een leeftijd van|jarigen)\W+(?:\w+\W+){0,3}$/i;

function jubileumJaren(hooi) {
  RONDE_JAREN.lastIndex = 0;
  let m;
  while ((m = RONDE_JAREN.exec(hooi)) !== null) {
    const getal = Number(m[1].replace(",", "."));
    const rond = getal === 12.5 || (Number.isInteger(getal) && getal >= 10 && getal <= 500 && getal % 5 === 0);
    if (!rond) continue;
    const ervoor = hooi.slice(Math.max(0, m.index - 40), m.index);
    if (LEEFTIJD_CONTEXT.test(ervoor)) continue;
    return m[0];
  }
  return null;
}

function beoordeelAgendaRelevantie(titel, tekst, filter) {
  if (filter !== "eerste-of-jubileum") {
    return { zichtbaar: true, regel: null, woorden: null, regelVersie: REGEL_VERSIE };
  }
  const hooi = `${titel || ""} ${tekst || ""}`.replace(LEEFTIJD, " ");
  let m = hooi.match(EERSTE_KEER);
  if (m) return { zichtbaar: true, regel: "eerste-keer", woorden: m[0], regelVersie: REGEL_VERSIE };
  m = hooi.match(JUBILEUM);
  if (m) return { zichtbaar: true, regel: "jubileum", woorden: m[0], regelVersie: REGEL_VERSIE };
  const jaren = jubileumJaren(hooi);
  if (jaren) return { zichtbaar: true, regel: "jubileum", woorden: jaren, regelVersie: REGEL_VERSIE };
  return { zichtbaar: false, regel: null, woorden: null, regelVersie: REGEL_VERSIE };
}

function dagNaarDate(dag) {
  return new Date(`${dag}T12:00:00Z`);
}

function dateNaarDag(d) {
  return d.toISOString().slice(0, 10);
}

function dagPlus(dag, aantal) {
  const d = dagNaarDate(dag);
  d.setUTCDate(d.getUTCDate() + aantal);
  return dateNaarDag(d);
}

function geldigeDatum(jaar, maand, dag) {
  const d = new Date(Date.UTC(jaar, maand - 1, dag, 12));
  return d.getUTCFullYear() === jaar && d.getUTCMonth() === maand - 1 && d.getUTCDate() === dag ? d : null;
}

const MAX_VOORUIT_DAGEN = 120;

const ABSOLUUT = new RegExp(`(?:(${WEEKDAG_PATROON})\\s+)?\\b(\\d{1,2})\\s+(${MAAND_PATROON})\\b\\.?(?:\\s+(\\d{4}))?`, "i");
const RELATIEF_DAG = /\b(vandaag|morgen|overmorgen)\b/i;
const RELATIEF_WEEKDAG = new RegExp(`\\b(?:op|aanstaande|komende|volgende)\\s+(${WEEKDAG_PATROON})\\b`, "i");

function datumUitTekst(tekst, publicatieDag) {
  if (!tekst || !publicatieDag) return null;
  const t = String(tekst);

  const m = t.match(ABSOLUUT);
  if (m) {
    const weekdag = m[1] ? WEEKDAGEN[m[1].toLowerCase()] : null;
    const dagnr = Number(m[2]);
    const maand = MAANDEN[m[3].toLowerCase()];
    const metJaar = m[4] ? Number(m[4]) : null;
    const pubJaar = Number(publicatieDag.slice(0, 4));

    const kandidaten = metJaar ? [metJaar] : [pubJaar, pubJaar + 1];
    for (const jaar of kandidaten) {
      const d = geldigeDatum(jaar, maand, dagnr);
      if (!d) continue;
      const dag = dateNaarDag(d);
      if (dag < publicatieDag) continue;
      if (dag > dagPlus(publicatieDag, MAX_VOORUIT_DAGEN) && !metJaar) return null;
      if (weekdag !== null && d.getUTCDay() !== weekdag) return null;
      return { dag, zekerheid: metJaar ? "letterlijk" : "afgeleid" };
    }
    return null;
  }

  const r = t.match(RELATIEF_DAG);
  if (r) {
    const plus = { vandaag: 0, morgen: 1, overmorgen: 2 }[r[1].toLowerCase()];
    return { dag: dagPlus(publicatieDag, plus), zekerheid: "afgeleid" };
  }

  const w = t.match(RELATIEF_WEEKDAG);
  if (w) {
    const doel = WEEKDAGEN[w[1].toLowerCase()];
    const start = dagNaarDate(publicatieDag).getUTCDay();
    let verschil = (doel - start + 7) % 7;
    if (verschil === 0) verschil = 7;
    return { dag: dagPlus(publicatieDag, verschil), zekerheid: "afgeleid" };
  }
  return null;
}

// De datum zoals die LETTERLIJK in een stukje tekst staat ("dinsdag 3 november",
// "12 nov", "op donderdag", "morgen"), of null. De omrekening naar een
// kalenderdag doet datumUitTekst; wat hier terugkomt staat dus altijd in de bron.
function vindDatumTekst(tekst) {
  const t = String(tekst ?? "");
  const absoluut = t.match(ABSOLUUT);
  if (absoluut) return absoluut[0].trim();
  const weekdag = t.match(RELATIEF_WEEKDAG);
  if (weekdag) return weekdag[0].trim();
  const dag = t.match(RELATIEF_DAG);
  return dag ? dag[0].trim() : null;
}

function klokUitTekst(tekst) {
  const t = String(tekst ?? "");
  let m = t.match(/(\d{1,2})\s*[:.u]\s*(\d{2})(?!\d)/i);
  if (!m) m = t.match(/(\d{1,2})\s*uur\b/i);
  if (!m) return null;
  const uur = Number(m[1]);
  const minuut = m[2] !== undefined ? Number(m[2]) : 0;
  if (uur > 23 || minuut > 59) return null;
  return [uur, minuut];
}

const TERMIJN_SOORTEN = [
  ["zienswijze", /\bzienswijz\w*/i],
  ["bezwaar", /\bbezwaar\w*/i],
  ["beroep", /\bberoep\w*/i],
  ["inspraak", /\binspraak\w*|\breageren\b/i],
];

const DATUM_MET_JAAR = new RegExp(`\\b(\\d{1,2})\\s+(${MAAND_PATROON})\\b\\.?\\s+(\\d{4})`, "gi");

function termijnenUitTekst(tekst, publicatieDag) {
  const t = String(tekst ?? "").replace(/\s+/g, " ");
  const uit = new Map();
  for (const [soort, patroon] of TERMIJN_SOORTEN) {
    const globaal = new RegExp(patroon.source, "gi");
    let m;
    while ((m = globaal.exec(t)) !== null) {
      const venster = t.slice(m.index, m.index + 200);
      DATUM_MET_JAAR.lastIndex = 0;
      let d;
      while ((d = DATUM_MET_JAAR.exec(venster)) !== null) {
        const datum = geldigeDatum(Number(d[3]), MAANDEN[d[2].toLowerCase()], Number(d[1]));
        if (!datum) continue;
        const dag = dateNaarDag(datum);
        if (publicatieDag && dag < publicatieDag) continue;
        if (publicatieDag && dag > dagPlus(publicatieDag, 400)) continue;
        const voor = venster.slice(Math.max(0, d.index - 25), d.index);
        if (!/(tot en met|t\/m|tot|uiterlijk|vóór|voor|binnen)\s*(?:en met\s*)?(?:\w+day\s*)?$/i.test(voor) &&
            !/(tot en met|t\/m|tot|uiterlijk|vóór|voor)\s+(?:\w+\s+)?$/i.test(voor)) continue;
        uit.set(`${soort}|${dag}`, { soort, dag });
      }
    }
  }
  return [...uit.values()].sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0));
}

const STOPWOORDEN = new Set([
  "de", "het", "een", "en", "van", "in", "op", "te", "voor", "met", "aan", "bij", "naar", "om", "of", "is", "zijn",
  "dit", "dat", "die", "wordt", "worden", "over", "uit", "tot", "als", "ook", "door", "tijdens", "live",
]);

function woordenVan(tekst) {
  return String(tekst ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWOORDEN.has(w));
}

function titelGelijkenis(a, b) {
  const wa = new Set(woordenVan(a));
  const wb = new Set(woordenVan(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let gemeenschappelijk = 0;
  for (const w of wa) if (wb.has(w)) gemeenschappelijk++;
  return gemeenschappelijk / (wa.size + wb.size - gemeenschappelijk);
}

module.exports = {
  REGEL_VERSIE,
  beoordeelAgendaRelevantie,
  datumUitTekst,
  vindDatumTekst,
  jubileumJaren,
  klokUitTekst,
  termijnenUitTekst,
  titelGelijkenis,
  woordenVan,
  dagPlus,
};
