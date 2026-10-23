// rubrieken.js
//
// ZANP-ronde (2026-10-23): de "desks" van de nieuwsdienst, naar het voorbeeld
// van de ANP-rubrieken (BIN, BUI, ECO, SPO).
//
// WAAROM EEN APART BESTAND en niet in bronnen.js?
// bronnen.js wordt ook automatisch herschreven (voeg-bron-toe.js,
// bronnen-schrijver.js, herstel-bronnen.js). Een extra veld daar zou bij zo'n
// herschrijving kunnen verdwijnen. Dit bestand blijft van jou.
//
// Een bron die hier niet staat (bijvoorbeeld net toegevoegd via "Bron
// toevoegen") valt terug op STANDAARD: rubriek ALG, prio 3 en NIET
// herschrijven. Dat is bewust de veilige kant: onbekend betekent alleen kop
// en link tonen, nooit een AI-tekst.
//
// VELDEN PER BRON
//   rubriek    code uit RUBRIEKEN
//   soort      "officieel"    overheid of rechtspraak, eerste hand
//              "organisatie"  eigen nieuws van een instelling (persbericht)
//              "signaal"      artikel van een andere redactie
//              "agenda"       evenement of zitting
//   prio       standaardprioriteit, 1 (urgent) t/m 4 (routine)
//   herschrijf mag de AI hier een korte feitelijke tekst van maken?
//              Alleen bij officieel en organisatie. Artikelen van andere
//              redacties (De Orkaan, Zaandijk Leeft!) worden NOOIT
//              herschreven: alleen hun kop en een link.

const RUBRIEKEN = [
  { code: "BES", naam: "Bestuur & gemeente" },
  { code: "REC", naam: "Rechtspraak" },
  { code: "PRV", naam: "Provincie, water & omgeving" },
  { code: "CUL", naam: "Cultuur & erfgoed" },
  { code: "ONW", naam: "Onderwijs" },
  { code: "LOK", naam: "Lokaal nieuws (signaal)" },
  { code: "ALG", naam: "Overig" },
];

const STANDAARD = { rubriek: "ALG", soort: "onbekend", prio: 3, herschrijf: false };

const PROFIELEN = {
  // --- Bestuur & gemeente ---
  bekendmakingen: { rubriek: "BES", soort: "officieel", prio: 4, herschrijf: true },
  wetenregelgeving: { rubriek: "BES", soort: "officieel", prio: 4, herschrijf: true },
  "ibabs-collegeberichten": { rubriek: "BES", soort: "officieel", prio: 3, herschrijf: true },
  "ibabs-ingekomen-stukken": { rubriek: "BES", soort: "officieel", prio: 4, herschrijf: true },
  "zaanstad-hoorzittingen": { rubriek: "BES", soort: "agenda", prio: 4, herschrijf: false },

  // --- Rechtspraak ---
  "rechtspraak-noord-holland": { rubriek: "REC", soort: "officieel", prio: 3, herschrijf: true },

  // --- Provincie, water & omgeving ---
  "nh-actueel": { rubriek: "PRV", soort: "officieel", prio: 3, herschrijf: true },
  "nh-cultuur": { rubriek: "PRV", soort: "officieel", prio: 4, herschrijf: true },
  hhnk: { rubriek: "PRV", soort: "officieel", prio: 3, herschrijf: true },
  OmgevingsdienstNHN: { rubriek: "PRV", soort: "officieel", prio: 4, herschrijf: true },
  omgevingsdienstnoordzeekanaal: { rubriek: "PRV", soort: "officieel", prio: 4, herschrijf: true },

  // --- Cultuur & erfgoed ---
  "zaans-museum": { rubriek: "CUL", soort: "organisatie", prio: 4, herschrijf: true },
  "zaanse-schans": { rubriek: "CUL", soort: "organisatie", prio: 4, herschrijf: true },
  "zaansche-molen": { rubriek: "CUL", soort: "organisatie", prio: 4, herschrijf: true },
  "zaans-cultuur-huis": { rubriek: "CUL", soort: "agenda", prio: 4, herschrijf: false },
  WaarheenAgenda: { rubriek: "CUL", soort: "agenda", prio: 4, herschrijf: false },

  // --- Onderwijs ---
  "blaise-pascal-college": { rubriek: "ONW", soort: "organisatie", prio: 4, herschrijf: true },
  "ovo-zaanstad": { rubriek: "ONW", soort: "organisatie", prio: 4, herschrijf: true },

  // --- Lokaal nieuws (andere redacties): alleen signaal, nooit herschrijven ---
  DeOrkaan: { rubriek: "LOK", soort: "signaal", prio: 3, herschrijf: false },
  "zaandijk-leeft": { rubriek: "LOK", soort: "signaal", prio: 3, herschrijf: false },
};

function profielVoor(bronId) {
  return PROFIELEN[bronId] || STANDAARD;
}

function isBekendeBron(bronId) {
  return Object.prototype.hasOwnProperty.call(PROFIELEN, bronId);
}

module.exports = { RUBRIEKEN, PROFIELEN, STANDAARD, profielVoor, isBekendeBron };
