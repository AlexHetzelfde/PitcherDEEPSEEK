// prioriteit/instellingen.js
//
// Alle constanten van de prioriteitsfunctie (rood kleuren) op één plek.
// Pas hier aan, nergens anders. Niets hiervan raakt het pitchdeel.
//
// MODUS (omgevingsvariabele ZANP_PRIORITEIT_MODUS, GitHub: Settings > Variables):
//   uit      de functie doet niets
//   schaduw  (standaard) rekenen, bewaren en loggen, maar NIETS kleuren
//   aan      rood wordt ook echt op agenda-items en berichten gezet
//
// AI-CONTROLE (omgevingsvariabele ZANP_PRIORITEIT_AI): 0 zet de AI-controle uit,
// alles anders (ook niets) laat hem aan. Zonder AI beslist de berekening.

"use strict";

const crypto = require("crypto");

// De formule. De waarden komen uit de ontwerpfase; stel ze bij met de
// schaduwlog (data/zanp-prioriteit/schaduwlog.json).
const FORMULE = Object.freeze({
  // Geheugen en verval
  geheugenDagen: 30, // zo lang blijven kernfeiten van een artikel bewaard
  tekstBewaarDagen: 30, // zo lang blijven de dagbestanden met volledige teksten in de repo staan
  halfwaardeDagen: 7, // na 7 dagen telt een artikel half, na 21 dagen ~12%
  roodBewaarDagen: 30, // een rood item blijft zo lang in het geheugen

  // Welke items worden beoordeeld
  nieuwsVersUren: 48, // een nieuwsbericht kan alleen rood worden in zijn eerste 48 uur
  agendaVooruitDagen: 14, // agenda-items tot 14 dagen vooruit
  nieuwsTopicUren: 168, // hooguit één rood nieuwsbericht per onderwerp per 7 dagen (het eerste bericht erna)

  // Zoekwoorden en matching
  queryMax: 12, // zoveel termen per item
  queryTekstTermen: 8, // extra termen uit de tekst zelf
  ankerRelatief: 0.6, // een anker weegt minstens 60% van het zwaarste woord
  ankerDfRelatief: 0.06, // en komt in hooguit 6% van de stukken voor
  ankerDfMin: 4, // (minimaal 4 stukken mag altijd)
  ankerMinGewicht: 1.0, // een item zonder woord van dit gewicht heeft geen eigen zoekwoord
  dekkingMin: 0.3, // een stuk moet minstens 30% van het zoekwoordgewicht bevatten
  minCentraliteit: 0.25, // lager = "alleen in voorbijgaan genoemd", telt niet mee
  templateMinDocs: 15, // een bron met minstens zoveel stukken kan sjabloonwoorden hebben
  templateAandeel: 0.3, // een woord in 30% van de stukken van één bron is sjabloon
  templateMinTreffers: 8,
  ankerMinLetters: 4, // een anker (of een deel van een naamcombinatie) heeft minstens 4 letters
  reeksJaccard: 0.4, // zelfde bron en minstens zoveel gelijkenis in de kop = reeks (zie analyse.js)
  soortAandeel: 0.025, // een woord in 2,5% van de agenda-koppen is een "soortwoord"
  soortMin: 3,
  termenPerDoc: 100, // hoeveel termen per stuk bewaard blijven

  // De score (zie score.js)
  kVolume: 4,
  kDuur: 3,
  kDiepte: 1000,
  kBreedte: 1.5,
  kPiek: 3,
  weegBreedte: 0.3,
  weegImpact: 0.3,
  weegImpactPiek: 0.6,
  impactDrempelPiek: 0.3, // de piekroute werkt alleen bij een impact-signaal (orde, conflict, aantal, geld)
  pieksVensterDagen: 2,

  // De drempel tau (zie score.js, bepaalTau)
  tauMin: 0.5,
  tauMax: 0.8,
  tauMadFactor: 3,
  tauMinItems: 12,

  // Besluit (zie beslis.js)
  bevestigRuns: 2, // score boven tau in 2 opeenvolgende runs
  hysterese: 0.05,
  noodremMax: 10, // meer dan zoveel nieuw rood in één run = verdacht

  // AI-controle (zie ai.js): mag alleen tegenhouden, nooit rood maken
  aiVerzoekenMax: 2, // hoogstens zoveel AI-verzoeken per run
  aiPerVerzoek: 6, // zoveel items per verzoek
});

function getal(env, naam, standaard) {
  if (!env || env[naam] === undefined || String(env[naam]).trim() === "") return standaard;
  const v = Number(env[naam]);
  return Number.isFinite(v) && v >= 0 ? v : standaard;
}

function leesInstellingen(env = process.env) {
  const gevraagd = String((env && env.ZANP_PRIORITEIT_MODUS) || "").trim().toLowerCase();
  const modus = ["uit", "schaduw", "aan"].includes(gevraagd) ? gevraagd : "schaduw";
  return {
    modus,
    ai: getal(env, "ZANP_PRIORITEIT_AI", 1) > 0,
    formule: FORMULE,
    // Tekst ophalen (tekst.js)
    tekstMaxPerRun: getal(env, "ZANP_PRIORITEIT_TEKST_MAX", 80),
    tekstMaxSeconden: getal(env, "ZANP_PRIORITEIT_TEKST_SECONDEN", 240),
    tekstParallel: 4,
    tekstPauzeMs: 300,
    tekstMaxTekens: 200000, // geen afkapping op 6.000 tekens zoals bij de AI-stap
    tekstMaxPogingen: 3,
  };
}

// De stempel van de formule. Verandert de formule (een constante hierboven, of
// de rekenregels zelf), dan wordt het rood uit de schaduwtijd gewist, zodat oud
// rood van een eerdere formule nooit meegaat naar de echte start (zie index.js).
//   - Verander je een constante in FORMULE, dan verandert de stempel vanzelf.
//   - Verander je de REKENREGELS zonder constante, verhoog dan FORMULE_VERSIE.
// Opruimen en AI-instellingen veranderen de uitkomst niet en tellen niet mee.
const FORMULE_VERSIE = 4; // 4: cameratoezicht valt buiten de formule (vaste regel, regels.js)
const NIET_IN_STEMPEL = ["tekstBewaarDagen", "aiVerzoekenMax", "aiPerVerzoek"];

function formuleStempel() {
  const telt = Object.fromEntries(Object.entries(FORMULE).filter(([k]) => !NIET_IN_STEMPEL.includes(k)));
  const hash = crypto.createHash("sha1").update(JSON.stringify(telt)).digest("hex").slice(0, 8);
  return `v${FORMULE_VERSIE}-${hash}`;
}

module.exports = { FORMULE, FORMULE_VERSIE, formuleStempel, leesInstellingen };
