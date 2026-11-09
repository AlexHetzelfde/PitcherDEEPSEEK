// scrapers/moties-tekst.js
//
// Haalt uit de tekst van een motie-PDF de "strekking": wat de motie vraagt.
// Geen AI: alleen vaste regels op de opbouw van een raadsmotie.
//
//   De gemeenteraad van Zaanstad, in vergadering bijeen op ...,
//   constaterende dat ...;            <- aanleiding
//   overwegende dat ...;              <- aanleiding
//   verzoekt het college ...;         <- het dictum = de strekking
//   en gaat over tot de orde van de dag.
//
// Volgorde:
//   1. dictum: de tekst vanaf "verzoekt het college" (of "draagt het college op",
//      "besluit", "spreekt uit", ...) tot "en gaat over tot de orde van de dag";
//   2. geen dictum gevonden: het begin van de tekst na de titel en de
//      aanhef ("De gemeenteraad van ..., in vergadering bijeen ...").
//
// Een paar eigenschappen die ertoe doen:
//   - Alles is stuk voor stuk testbaar: knipStrekking(tekst, titel) heeft geen
//     netwerk en geen bijwerkingen.
//   - De uitvoer wordt nooit langer dan de grenzen hieronder, en wordt
//     afgekapt op een zin- of woordgrens, nooit midden in een woord.

"use strict";

const MAX_STREKKING_TEKENS = 700;
const MAX_AANLEIDING_TEKENS = 320;

// Het begin van een dictum. Volgorde van de lijst is niet van belang: de
// vroegste plek in de tekst wint.
const DICTUM_START = [
  /\bverzoekt\s+(?:het\s+college|de\s+burgemeester|het\s+presidium|de\s+griffie|de\s+gemeenteraad|het\s+dagelijks\s+bestuur|burgemeester)/i,
  /\bverzoeken\s+(?:het\s+college|de\s+burgemeester)/i,
  /\bdraagt\s+(?:het\s+college|de\s+burgemeester)[^.;:]{0,30}\bop\b/i,
  /\broept\s+(?:het\s+college|de\s+burgemeester)[^.;:]{0,30}\bop\b/i,
  /\bnodigt\s+(?:het\s+college|de\s+burgemeester)\s+uit/i,
  /\bspreekt\s+uit\b/i,
  /\bbesluit\s*:/i,
];

// Het einde van een dictum.
const DICTUM_EINDE = [
  /\ben\s+gaat\s+over\s+tot\s+de\s+orde\s+van\s+de\s+dag/i,
  /\bgaat\s+over\s+tot\s+de\s+orde\s+van\s+de\s+dag/i,
  /\bIndiener\(?s?\)?\s*:/i,
  /\bOndertekend\s+door\b/i,
];

// De aanleiding: eerste constaterende/overwegende-zin.
const AANLEIDING_START = /\b(?:constaterende|overwegende|gezien|gelet\s+op|erkennende|van\s+mening)\s+dat\b/i;

function schoon(tekst) {
  return String(tekst || "")
    .replace(/­/g, "") // zachte afbreekstreepjes
    .replace(/-\s*\n\s*(?=[a-zà-ÿ])/g, "") // woordafbreking aan het regeleinde
    .replace(/[ \t\r\n ]+/g, " ")
    .trim();
}

function kapAf(tekst, max) {
  const t = String(tekst || "").trim();
  if (t.length <= max) return t;
  const stuk = t.slice(0, max);
  // Liefst op een zingrens, anders op het laatste woord.
  const zin = Math.max(stuk.lastIndexOf(". "), stuk.lastIndexOf("; "));
  if (zin > max * 0.5) return `${stuk.slice(0, zin + 1).trim()}`;
  const woord = stuk.lastIndexOf(" ");
  return `${(woord > max * 0.5 ? stuk.slice(0, woord) : stuk).trim()}…`;
}

function vroegsteMatch(tekst, regexen, vanaf = 0) {
  let beste = null;
  for (const re of regexen) {
    const m = re.exec(tekst.slice(vanaf));
    if (m && (beste === null || m.index < beste.index)) beste = { index: m.index + vanaf, lengte: m[0].length };
  }
  return beste;
}

/** Haalt de titelregel(s) en de aanhef weg zodat de echte inhoud overblijft. */
function zonderKopEnAanhef(tekst, titel) {
  let t = tekst;
  const titelSchoon = schoon(titel);
  if (titelSchoon) {
    const i = t.toLowerCase().indexOf(titelSchoon.toLowerCase());
    // Alleen als de titel vooraan staat; anders laten we de tekst met rust.
    if (i >= 0 && i < 200) t = t.slice(i + titelSchoon.length).trim();
  }
  // Aanhef: "De gemeenteraad van Zaanstad, in vergadering bijeen op 10 november 2026,"
  t = t.replace(/^(?:motie\s*)?(?:onderwerp\s*:\s*)?/i, "");
  t = t.replace(/^de\s+gemeenteraad\s+van\s+\w+[^,;]*,?\s+in\s+vergadering\s+bijeen[^,;]*[,;]?\s*/i, "");
  t = t.replace(/^gehoord\s+de\s+beraadslaging[^;,]*[;,]?\s*/i, "");
  return t.trim();
}

/**
 * Knipt de strekking en de aanleiding uit de PDF-tekst.
 *
 * @param {string} pdfTekst  platte tekst uit de PDF
 * @param {string} [titel]   titel van de motie (om de kop uit de tekst te halen)
 * @returns {{ strekking: string, aanleiding: string|null, bron: "dictum"|"begin"|"geen" }}
 */
function knipStrekking(pdfTekst, titel = "") {
  const tekst = schoon(pdfTekst);
  if (!tekst) return { strekking: "", aanleiding: null, bron: "geen" };

  // De aanleiding staat vóór het dictum.
  const start = vroegsteMatch(tekst, DICTUM_START);
  const voorDictum = start ? tekst.slice(0, start.index) : tekst;
  let aanleiding = null;
  const a = AANLEIDING_START.exec(voorDictum);
  if (a) {
    const rest = voorDictum.slice(a.index).trim();
    // Tot de eerste puntkomma of het volgende "overwegende"-blok.
    const eind = rest.search(/;\s|\.\s(?=[A-Z])/);
    aanleiding = kapAf(eind > 0 ? rest.slice(0, eind + 1) : rest, MAX_AANLEIDING_TEKENS);
  }

  if (start) {
    const vanafDictum = tekst.slice(start.index);
    const einde = vroegsteMatch(vanafDictum, DICTUM_EINDE, 1);
    const dictum = (einde ? vanafDictum.slice(0, einde.index) : vanafDictum)
      .replace(/[\s;,]+$/g, "")
      .trim();
    if (dictum.length >= 20) {
      return { strekking: kapAf(dictum, MAX_STREKKING_TEKENS), aanleiding, bron: "dictum" };
    }
  }

  const begin = zonderKopEnAanhef(tekst, titel);
  if (begin.length >= 20) {
    return { strekking: kapAf(begin, MAX_STREKKING_TEKENS), aanleiding: null, bron: "begin" };
  }
  return { strekking: "", aanleiding: null, bron: "geen" };
}

module.exports = { knipStrekking, MAX_STREKKING_TEKENS, MAX_AANLEIDING_TEKENS };
