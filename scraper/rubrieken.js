// rubrieken.js
//
// Laadt scraper/rubrieken.json: de ZANP-instellingen per bron (rubriek,
// herkomst, standaardprio, mag de AI herschrijven, agendafilter).
//
// WAAROM JSON EN APART VAN bronnen.js?
// bronnen.js wordt ook automatisch herschreven (voeg-bron-toe.js,
// herstel-bronnen.js). Dit bestand blijft van jou, en de workflow "Bron
// toevoegen" schrijft er zelf een regel in (voegProfielToe). Soort (nieuws of
// agenda), categorie en frequentie (rustig) blijven in bronnen.js staan; er is
// dus maar één plek per gegeven.
//
// DEFENSIEF: is het bestand kapot (bijvoorbeeld een typefout bij handmatig
// bewerken), dan draait ZANP door met de veilige standaard en staat er een
// duidelijke foutregel in de log. Een JSON-fout mag een run nooit laten
// crashen.
//
// Een bron die er niet in staat valt terug op STANDAARD: rubriek Overig,
// herkomst onbekend, GEEN AI-tekst en agendafilter uit. Zo zie je een
// vergeten bron meteen in plaats van dat hij stilletjes verdwijnt.
//
// herkomst
//   officieel    overheid of rechtspraak, eerste hand
//   organisatie  eigen nieuws van een instelling (persbericht)
//   signaal      artikel of agenda van een andere redactie of aggregator
//   onbekend     nog niet ingesteld
// Artikelen van andere redacties (herkomst signaal) worden NOOIT herschreven.

const fs = require("fs");
const path = require("path");

const PAD = path.join(__dirname, "rubrieken.json");

const STANDAARD_RUBRIEKEN = [{ code: "ALG", naam: "Overig" }];
const STANDAARD = { rubriek: "ALG", herkomst: "onbekend", prio: 3, herschrijf: false, agendaFilter: "alles" };

function leesBestand(pad = PAD) {
  try {
    const data = JSON.parse(fs.readFileSync(pad, "utf-8"));
    return {
      rubrieken: Array.isArray(data.rubrieken) && data.rubrieken.length ? data.rubrieken : STANDAARD_RUBRIEKEN,
      bronnen: data.bronnen && typeof data.bronnen === "object" ? data.bronnen : {},
      ok: true,
      data,
    };
  } catch (fout) {
    console.error(`[rubrieken] rubrieken.json kon niet gelezen worden (${fout.message}). ZANP gebruikt de veilige standaard: alles onder Overig, geen AI-tekst.`);
    return { rubrieken: STANDAARD_RUBRIEKEN, bronnen: {}, ok: false, data: null };
  }
}

const geladen = leesBestand();
const RUBRIEKEN = geladen.rubrieken;
const PROFIELEN = geladen.bronnen;

function profielVoor(bronId) {
  const p = PROFIELEN[bronId];
  if (!p) return STANDAARD;
  const profiel = { ...STANDAARD, ...p };
  // Vangnet voor een handmatige fout in rubrieken.json: alleen officiële
  // bronnen en organisaties mogen herschreven worden, nooit de rest.
  profiel.herschrijf = profiel.herschrijf === true && (profiel.herkomst === "officieel" || profiel.herkomst === "organisatie");
  return profiel;
}

function isBekendeBron(bronId) {
  return Object.prototype.hasOwnProperty.call(PROFIELEN, bronId);
}

// Voor "Bron toevoegen": schrijft of vervangt de regel van een bron.
function voegProfielToe(bronId, profiel, pad = PAD) {
  const huidig = leesBestand(pad);
  if (!huidig.ok || !huidig.data) throw new Error("rubrieken.json is onleesbaar; herstel dat eerst.");
  const geldigeRubrieken = new Set(huidig.rubrieken.map((r) => r.code));
  if (!geldigeRubrieken.has(profiel.rubriek)) throw new Error(`Onbekende rubriek "${profiel.rubriek}".`);
  const schoon = {
    rubriek: profiel.rubriek,
    herkomst: profiel.herkomst || "onbekend",
    prio: Number.isInteger(profiel.prio) ? profiel.prio : 3,
    herschrijf: profiel.herschrijf === true,
  };
  if (profiel.agendaFilter) schoon.agendaFilter = profiel.agendaFilter;
  if (schoon.herkomst === "signaal") schoon.herschrijf = false; // nooit andermans artikel herschrijven
  huidig.data.bronnen = { ...huidig.bronnen, [bronId]: schoon };
  fs.writeFileSync(pad, `${JSON.stringify(huidig.data, null, 2)}\n`, "utf-8");
  return schoon;
}

module.exports = { RUBRIEKEN, PROFIELEN, STANDAARD, profielVoor, isBekendeBron, voegProfielToe, leesBestand, PAD };
