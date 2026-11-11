// jubileum.js — 50-, 75- en 100-jarige jubilea worden rood
//
// Een vaste regel, los van de prioriteitsmodule (scraper/prioriteit/): die kleurt
// alleen in modus "aan" en op score. Een jubileum van een organisatie, gebouw of
// evenement hoeft niet eerst een score te halen; de regel zegt het direct.
//
// Wat telt:
//   - 50, 75 of 100 jaar (cijfers of in woorden: vijftig, vijfenzeventig,
//     honderd), of "eeuwfeest"
//   - én een woord dat op een jubileum wijst (jubileum, bestaan, viert,
//     lustrum, geleden, herdenking, opgericht, ...). "50 jaar" op zichzelf is te
//     vaag: "vanaf 50 jaar", "50 jaar ervaring", "50 jaar en ouder". Een kop
//     in de vorm "50 jaar Koperen Bel" (getal vooraan, daarna een naam met
//     hoofdletter) telt ook zonder jubileumwoord.
//
// Wat niet telt (jubilea van personen):
//   - huwelijken (gouden bruidspaar, 50 jaar getrouwd)
//   - dienstjubilea en lidmaatschappen (in dienst, ambtsjubileum, lid sinds)
//   - een leeftijd van een persoon (100 jaar oud, honderdjarige, 100-jarige
//     inwoner/mevrouw/meneer)
//   Wat is uitgesloten, komt met een voorbeeld in het logboek, zodat je kunt
//   zien of de uitsluiting klopt.
//
// Alleen de kop (en de bron-titel van berichten, en de woorden waarop het
// agendafilter aansloeg) wordt bekeken, niet de hele tekst: zo blijft de kans op
// toevallige treffers klein.
//
// De regel wordt elke run opnieuw bepaald en niet bewaard. Een item dat al rood
// is door de prioriteitsmodule houdt die reden.

"use strict";

const runlog = require("./runlog");

const JUBILEUM_JAREN = [50, 75, 100];

const WOORD_NAAR_JAREN = { vijftig: 50, vijfenzeventig: 75, honderd: 100 };

// "50 jaar", "75-jarig", "100 jarige", "honderd jaar". Niet als onderdeel van een
// groter getal ("150 jaar", "2.100 jaar") en niet als leeftijdsgrens ("50 jaar en ouder").
const JAREN_CIJFER = /(?<![\d,.])(50|75|100)\s*[- ]?\s*(?:jaar|jarig\w*)\b(?!\s*(?:oud\b|en ouder|of ouder|\+))/gi;
const JAREN_WOORD = /\b(vijftig|vijfenzeventig|honderd)\s*[- ]?\s*(?:jaar|jarig\w*)\b(?!\s*(?:oud\b|en ouder|of ouder|\+))/gi;
const EEUWFEEST = /\beeuwfeest\b/i;

// Een jaargetal alleen als jubileum lezen als er een jubileumwoord bij staat.
const JUBILEUM_CONTEXT =
  /\b(jubile\w+|lustrum|bestaan|bestaat|viert|vieren|gevierd|feest\w*|geleden|herdenk\w*|herdenking|vrijheid|bevrijding|opgericht|oprichting|eeuwfeest)\b/i;

// Een kop als "50 jaar Koperen Bel" of "Terug in de tijd: 100 jaar Zaanse Schans":
// het getal staat vooraan (of na een dubbele punt of streep) en een naam met
// hoofdletter volgt. Zonder verdere context is dat een jubileumkop; "50 jaar
// ervaring" (kleine letter) niet.
const KOP_JAAR_NAAM = /(?:^|[:–—-]\s*)(?:50|75|100)\s+jaar\s+[A-ZÀ-Ý]/;

// Een leeftijdsgrens vlak voor het getal: "vanaf 50 jaar", "tot 75 jaar".
const LEEFTIJD_ERVOOR = /\b(?:vanaf|v\.a\.|tot|t\/m|boven|onder|ouder dan|jonger dan|leeftijd|leeftijden)\s*(?:de\s+)?(?:van\s+)?$/i;

// Jubilea van personen en huwelijken.
const PERSOON = [
  { reden: "huwelijk", patroon: /\b(getrouwd|gehuwd|huwelijk\w*|bruiloft|bruidspaar|echtpaar|trouwdag|trouwerij)\b/i },
  { reden: "dienstverband of lidmaatschap", patroon: /\b(in dienst|dienstjubileum|dienstverband|ambtsjubileum|werkzaam|lid sinds|lidmaatschap)\b/i },
  {
    reden: "leeftijd van een persoon",
    patroon:
      /\b(?:jarige|jaar oud)\s+(?:inwoner\w*|bewoner\w*|mevrouw|meneer|man|vrouw|oma|opa|dame|heer)\b|\bhonderdjarige\b|\b(?:50|75|100)\s*jaar\s+(?:oud|geworden)\b/i,
  },
];

function jarenUit(tekst) {
  const gevonden = [];
  for (const [re, naarJaren] of [
    [JAREN_CIJFER, (m) => Number(m[1])],
    [JAREN_WOORD, (m) => WOORD_NAAR_JAREN[m[1].toLowerCase()]],
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(tekst)) !== null) {
      const ervoor = tekst.slice(Math.max(0, m.index - 25), m.index);
      if (LEEFTIJD_ERVOOR.test(ervoor)) continue;
      gevonden.push({ jaren: naarJaren(m), woorden: m[0] });
    }
  }
  if (EEUWFEEST.test(tekst)) gevonden.push({ jaren: 100, woorden: "eeuwfeest" });
  return gevonden.filter((g) => JUBILEUM_JAREN.includes(g.jaren));
}

/**
 * Is dit een 50-, 75- of 100-jarig jubileum van een organisatie of evenement?
 * @param {string} tekst  de kop (eventueel met bron-titel)
 * @returns {{rood: true, jaren: number, woorden: string, reden: string}
 *         | {rood: false, uitgesloten: string, jaren: number, woorden: string}
 *         | null}  null als er geen jubileumjaar in staat
 */
function beoordeelJubileum(tekst) {
  const t = String(tekst || "");
  const jaren = jarenUit(t);
  if (!jaren.length) return null;
  if (!JUBILEUM_CONTEXT.test(t) && !KOP_JAAR_NAAM.test(t)) return null;

  const eerste = jaren[0];
  for (const p of PERSOON) {
    if (p.patroon.test(t)) return { rood: false, uitgesloten: p.reden, jaren: eerste.jaren, woorden: eerste.woorden };
  }
  return {
    rood: true,
    jaren: eerste.jaren,
    woorden: eerste.woorden,
    reden: `Jubileum: ${eerste.jaren} jaar (${eerste.woorden})`,
  };
}

function roodVan(oordeel, item) {
  return {
    sinds: item.eerstGezienOp || null,
    score: 1,
    route: "regel",
    reden: oordeel.reden,
    label: `jubileum ${oordeel.jaren} jaar`,
  };
}

/**
 * Zet rood op berichten en agenda-items met een 50-, 75- of 100-jarig jubileum.
 * Items die al rood zijn blijven ongemoeid. Met `nu` komt alleen een item dat
 * de afgelopen twee uur voor het eerst is gezien als regel in het Actions-log;
 * zonder `nu` komt elk item erin (de tellers en voorbeelden tellen altijd mee).
 * @returns {{records: Array, agendaItems: Array, stats: object}}
 */
function pasJubileumRoodToe({ records, agendaItems, nu = null, log = runlog.huidig() }) {
  const stats = { nieuwsRood: 0, agendaRood: 0, uitgesloten: 0, alRood: 0 };

  function beoordeel(soort, item, tekst) {
    const o = beoordeelJubileum(tekst);
    if (!o) return item;
    if (!o.rood) {
      stats.uitgesloten++;
      log.voorbeeld("jubileum", { soort, uitgesloten: o.uitgesloten, jaren: o.jaren, kop: String(item.kop || "").slice(0, 100) }, 12);
      return item;
    }
    if (item.rood) {
      stats.alRood++;
      return item;
    }
    stats[soort === "nieuws" ? "nieuwsRood" : "agendaRood"]++;
    log.voorbeeld("jubileum", { soort, rood: true, jaren: o.jaren, woorden: o.woorden, kop: String(item.kop || "").slice(0, 100) }, 12);
    const nieuw = !nu || (item.eerstGezienOp && nu.getTime() - Date.parse(item.eerstGezienOp) <= 2 * 3600 * 1000);
    if (nieuw) log.regel("jubileum", `ROOD (${soort}): ${String(item.kop || "").slice(0, 80)} — ${o.reden}`);
    return { ...item, rood: roodVan(o, item) };
  }

  const nieuweRecords = (records || []).map((r) => beoordeel("nieuws", r, `${r.kop || ""} · ${r.bronTitel || ""}`));
  const nieuweAgenda = (agendaItems || []).map((i) =>
    beoordeel("agenda", i, `${i.kop || ""} · ${(i.relevantie && i.relevantie.regel === "jubileum" && i.relevantie.woorden) || ""}`)
  );

  log.tel("jubileum", "nieuwsRood", stats.nieuwsRood);
  log.tel("jubileum", "agendaRood", stats.agendaRood);
  log.tel("jubileum", "uitgesloten", stats.uitgesloten);
  log.tel("jubileum", "alRoodDoorPrioriteit", stats.alRood);
  return { records: nieuweRecords, agendaItems: nieuweAgenda, stats };
}

module.exports = { beoordeelJubileum, pasJubileumRoodToe, JUBILEUM_JAREN };
