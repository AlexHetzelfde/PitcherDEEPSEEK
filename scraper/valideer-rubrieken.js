// valideer-rubrieken.js
//
// Controleert scraper/rubrieken.json (de ZANP-instellingen per bron).
// Bewust APART van valideer-bronnen.js: een fout in rubrieken.json mag de
// pitchmachine nooit stoppen. De dagelijkse pitchrun roept dit script dus niet
// aan; controle.yml (bij elke push) en "Bron toevoegen" wel, en de ZANP-run
// draait het met continue-on-error.
//
// Fouten (exit 1): kapot JSON, onbekende rubriek of herkomst, ongeldige prio,
//   herschrijven bij een bron die we niet mogen herschrijven.
// Waarschuwingen (exit 0): een bron zonder regel, of een regel zonder bron.
//
// Gebruik: node valideer-rubrieken.js [pad naar rubrieken.json]

const fs = require("fs");
const path = require("path");

const HERKOMSTEN = ["officieel", "organisatie", "signaal", "onbekend"];
const AGENDAFILTERS = ["alles", "eerste-of-jubileum"];

function valideer(data, bronnen) {
  const fouten = [];
  const waarschuwingen = [];

  if (!data || typeof data !== "object") return { fouten: ["rubrieken.json is geen object."], waarschuwingen };

  const rubrieken = Array.isArray(data.rubrieken) ? data.rubrieken : [];
  if (rubrieken.length === 0) fouten.push('"rubrieken" ontbreekt of is leeg.');
  const codes = new Set();
  for (const r of rubrieken) {
    if (!r || typeof r.code !== "string" || typeof r.naam !== "string" || !r.code || !r.naam) {
      fouten.push(`Rubriek zonder code of naam: ${JSON.stringify(r)}`);
      continue;
    }
    if (codes.has(r.code)) fouten.push(`Rubriekcode "${r.code}" staat twee keer in de lijst.`);
    codes.add(r.code);
  }
  if (!codes.has("ALG")) fouten.push('De rubriek "ALG" (Overig) moet bestaan: zij is de terugval voor onbekende bronnen.');

  const regels = data.bronnen && typeof data.bronnen === "object" ? data.bronnen : null;
  if (!regels) {
    fouten.push('"bronnen" ontbreekt of is geen object.');
    return { fouten, waarschuwingen };
  }

  const bronPerId = Object.fromEntries((bronnen || []).map((b) => [b.id, b]));
  for (const [id, p] of Object.entries(regels)) {
    const waar = `Bron "${id}"`;
    if (!p || typeof p !== "object") {
      fouten.push(`${waar}: regel is geen object.`);
      continue;
    }
    if (!codes.has(p.rubriek)) fouten.push(`${waar}: onbekende rubriek "${p.rubriek}".`);
    if (!HERKOMSTEN.includes(p.herkomst)) fouten.push(`${waar}: onbekende herkomst "${p.herkomst}" (kies ${HERKOMSTEN.join(", ")}).`);
    if (!Number.isInteger(p.prio) || p.prio < 1 || p.prio > 4) fouten.push(`${waar}: prio moet 1 t/m 4 zijn, niet ${JSON.stringify(p.prio)}.`);
    if (typeof p.herschrijf !== "boolean") fouten.push(`${waar}: herschrijf moet true of false zijn.`);
    if (p.herschrijf === true && !(p.herkomst === "officieel" || p.herkomst === "organisatie")) {
      fouten.push(`${waar}: herschrijf staat aan terwijl de herkomst "${p.herkomst}" is. Artikelen van andere redacties en onbekende bronnen worden nooit herschreven.`);
    }
    if (p.agendaFilter !== undefined && !AGENDAFILTERS.includes(p.agendaFilter)) {
      fouten.push(`${waar}: onbekend agendaFilter "${p.agendaFilter}" (kies ${AGENDAFILTERS.join(" of ")}).`);
    }
    if (bronnen && !bronPerId[id]) waarschuwingen.push(`${waar} staat in rubrieken.json maar niet (meer) in bronnen.js.`);
    if (bronPerId[id] && p.agendaFilter && bronPerId[id].soort !== "agenda") {
      waarschuwingen.push(`${waar}: agendaFilter is ingesteld maar de bron is geen agendabron; het filter doet niets.`);
    }
  }
  for (const b of bronnen || []) {
    if (!Object.prototype.hasOwnProperty.call(regels, b.id)) {
      waarschuwingen.push(`Bron "${b.id}" heeft nog geen regel in rubrieken.json: rubriek Overig, geen AI-tekst.`);
    }
  }
  return { fouten, waarschuwingen };
}

function main() {
  const pad = process.argv[2] || path.join(__dirname, "rubrieken.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(pad, "utf-8"));
  } catch (fout) {
    console.error(`::error file=${pad}::rubrieken.json is geen geldig JSON: ${fout.message}`);
    process.exit(1);
  }
  let bronnen = null;
  try {
    bronnen = require("./bronnen");
  } catch (fout) {
    console.warn(`bronnen.js kon niet geladen worden (${fout.message}); de kruiscontrole wordt overgeslagen.`);
  }
  const { fouten, waarschuwingen } = valideer(data, bronnen);
  waarschuwingen.forEach((w) => console.log(`::warning file=scraper/rubrieken.json::${w}`));
  fouten.forEach((f) => console.error(`::error file=scraper/rubrieken.json::${f}`));
  if (fouten.length) {
    console.error(`\n✗ rubrieken.json heeft ${fouten.length} fout(en).`);
    process.exit(1);
  }
  console.log(`✓ rubrieken.json is in orde (${Object.keys(data.bronnen).length} bronnen${waarschuwingen.length ? `, ${waarschuwingen.length} waarschuwing(en)` : ""}).`);
}

if (require.main === module) main();

module.exports = { valideer };
