// aanbesteding-regels.js
//
// Gedeeld rekenwerk voor de aanbestedingen van TED en TenderNed: welk soort
// publicatie is het, wat is de status, hoe luidt de kop. Geen netwerk en geen
// bestanden, zodat het te testen is.
//
// DE STATUSFOUT UIT IBABSLOS2 (en de oplossing)
// IbabsLos2 noemde elk gunningsbericht ("can-standard", "can-social") "gegund".
// Maar een gunningsbericht zonder winnaar en zonder gegund bedrag betekent dat
// er GEEN opdracht is gegund (bijvoorbeeld een ingetrokken procedure). Zo stond
// de huur van vuilniswagens (procedure 0bb9c9f2…) als "gegund", terwijl er
// niemand is aangewezen. Hier geldt:
//   gunning              gunningsbericht MET winnaar of gegund bedrag
//   zonder-gunning       gunningsbericht ZONDER winnaar en zonder bedrag
//   ingetrokken          de titel of het type zegt het uitdrukkelijk
// "Zonder gunning" betekent dus: het bericht meldt geen winnaar. Of de
// procedure is ingetrokken of mislukt, staat in de bron zelf; ZANP zegt dat niet.

"use strict";

const { TZ } = require("./hulpmiddelen");

const INTREKKING = /ingetrokken|intrekking|geannuleerd|annulering|geen gunning|niet gegund/i;

const SOORT_LABELS = {
  aankondiging: "Aankondiging van een opdracht",
  vooraankondiging: "Vooraankondiging",
  marktconsultatie: "Marktconsultatie",
  gunning: "Gunning",
  "zonder-gunning": "Afgerond zonder gunning",
  ingetrokken: "Ingetrokken",
  wijziging: "Wijziging",
  "voornemen-zonder-aanbesteding": "Voornemen tot gunning zonder aanbesteding",
  overig: "Publicatie",
};

/**
 * TED: het soort publicatie uit het eForms notice-type, de titel en de gunningsgegevens.
 * @param {{ noticeType?: string, titel?: string, heeftWinnaar?: boolean, heeftBedrag?: boolean }} p
 * @returns {"aankondiging"|"vooraankondiging"|"marktconsultatie"|"gunning"|"zonder-gunning"|"ingetrokken"|"wijziging"|"voornemen-zonder-aanbesteding"|"overig"}
 */
function soortVanTed({ noticeType, titel, heeftWinnaar, heeftBedrag }) {
  const type = String(noticeType || "").toLowerCase();
  if (INTREKKING.test(String(titel || ""))) return "ingetrokken";
  if (type === "can-modif" || type.endsWith("-modif")) return "wijziging";
  if (type === "veat") return "voornemen-zonder-aanbesteding";
  if (type === "pmc") return "marktconsultatie";
  if (type.startsWith("pin")) return "vooraankondiging";
  if (type.startsWith("can-")) return heeftWinnaar || heeftBedrag ? "gunning" : "zonder-gunning";
  if (type.startsWith("cn-")) return "aankondiging";
  return "overig";
}

/**
 * TenderNed: het soort publicatie uit de omschrijvingen van typePublicatie en
 * publicatiecode. De waarden zijn niet allemaal geverifieerd; onbekend wordt
 * "overig" met de originele tekst in de pop-up.
 */
function soortVanTenderned({ typeOmschrijving, codeOmschrijving, titel }) {
  const t = `${typeOmschrijving || ""} ${codeOmschrijving || ""}`.toLowerCase();
  if (INTREKKING.test(`${t} ${titel || ""}`)) return "ingetrokken";
  if (/vooraankondiging|voorinformatie/.test(t)) return "vooraankondiging";
  if (/marktconsultatie/.test(t)) return "marktconsultatie";
  if (/wijziging|rectificatie|verbetering/.test(t)) return "wijziging";
  if (/gegunde|gunning|resultaat/.test(t)) return "gunning";
  if (/vrijwillige|zonder voorafgaande|ex ante|transparantie/.test(t)) return "voornemen-zonder-aanbesteding";
  if (/aankondiging|opdracht|inschrijving|aanbesteding/.test(t)) return "aankondiging";
  return "overig";
}

/** "Nederland – Vuilniswagens – Huur Vuilniswagens" → "Huur Vuilniswagens". */
function schoneTitel(titel) {
  const t = String(titel || "").replace(/\s+/g, " ").trim();
  const delen = t.split(/\s+[–—]\s+/);
  if (delen.length >= 3 && delen[0].length <= 25) return delen.slice(2).join(" – ").trim();
  return t;
}

function euro(waarde) {
  const n = Number(waarde);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `€ ${Math.round(n).toLocaleString("nl-NL")}`;
}

/** "2026-11-04+01:00" of "2026-11-04T12:00:00+01:00" → "2026-11-04". */
function dagVan(tekst) {
  const m = String(tekst || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** De Amsterdamse middernacht van een kalenderdag, als ISO (UTC). Zo toont ZANP geen verzonnen kloktijd. */
function middernachtAmsterdam(dag) {
  const [j, m, d] = dag.split("-").map(Number);
  const gok = Date.UTC(j, m - 1, d, 0, 0);
  const getoond = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(gok));
  const [datumDeel, tijdDeel] = getoond.split(" ");
  const [uj, um, ud] = datumDeel.split("-").map(Number);
  const [uu, umin] = tijdDeel.split(":").map(Number);
  const verschil = Date.UTC(uj, um - 1, ud, uu, umin) - gok;
  return new Date(gok - verschil).toISOString();
}

/** De kop van een bericht, afgeleid van alleen deze ene publicatie (dus stabiel). */
function bouwKop(soort, titel, winnaars = []) {
  const naam = schoneTitel(titel) || "(zonder titel)";
  switch (soort) {
    case "aankondiging":
      return `Gemeente zoekt aanbieders: ${naam}`;
    case "vooraankondiging":
      return `Vooraankondiging aanbesteding: ${naam}`;
    case "marktconsultatie":
      return `Marktconsultatie: ${naam}`;
    case "gunning":
      return winnaars.length ? `Aanbesteding gegund aan ${winnaars.slice(0, 2).join(" en ")}: ${naam}` : `Aanbesteding gegund: ${naam}`;
    case "zonder-gunning":
      return `Aanbesteding afgerond zonder gunning: ${naam}`;
    case "ingetrokken":
      return `Aanbesteding ingetrokken: ${naam}`;
    case "wijziging":
      return `Aanbesteding gewijzigd: ${naam}`;
    case "voornemen-zonder-aanbesteding":
      return `Opdracht zonder aanbesteding: ${naam}`;
    default:
      return `Aanbesteding: ${naam}`;
  }
}

/** De bijbehorende tekst, voor tags en zoeken (komt niet langs de AI). */
function bouwSamenvatting(a) {
  const delen = [`${bouwKop(a.soort, a.titel, a.winnaars)}.`];
  if (a.koper) delen.push(`Opdrachtgever: ${a.koper}.`);
  const geraamd = euro(a.geraamdeWaarde);
  const gegund = euro(a.gegundeWaarde);
  if (geraamd) delen.push(`Geraamde waarde: ${geraamd}.`);
  if (gegund) delen.push(`Gegunde waarde: ${gegund}.`);
  if (a.winnaars && a.winnaars.length) delen.push(`Winnaar: ${a.winnaars.join(", ")}.`);
  if (a.sluitingsdatum) delen.push(`Sluitingsdatum: ${a.sluitingsdatum}.`);
  if (a.soort === "zonder-gunning") delen.push("Het bericht meldt geen winnaar en geen gegund bedrag.");
  if (a.omschrijving) delen.push(String(a.omschrijving).replace(/\s+/g, " ").slice(0, 400));
  return delen.join(" ");
}

module.exports = {
  SOORT_LABELS,
  soortVanTed,
  soortVanTenderned,
  schoneTitel,
  euro,
  dagVan,
  middernachtAmsterdam,
  bouwKop,
  bouwSamenvatting,
};
