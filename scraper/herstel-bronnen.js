// herstel-bronnen.js
//
// Zelfherstel voor bronnen die niets meer opleveren.
//
// Sinds de "schone tekst"-ronde (2026-10-13): de bestaande detailSelector van
// een bron wordt doorgegeven aan ontdekBron, zodat het veld behouden blijft
// bij het opnieuw uitzoeken van de bron.

const { execFileSync } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const bronnen = require("./bronnen");
const { ontdekBron, maakRapport, schrijfStapSamenvatting } = require("./bron-ontdekking");
const { schrijfBron, bronNaarTekst } = require("./bronnen-schrijver");
const { voorbeeldRegels } = require("./bron-poort");

const MIN_DAGEN = Number(process.env.HERSTEL_MIN_DAGEN || 2);
const MIN_DAGEN_RUSTIG = Number(process.env.HERSTEL_MIN_DAGEN_RUSTIG || 14);
const MAX_PER_RUN = Number(process.env.HERSTEL_MAX_PER_RUN || 3);
const DROOG = process.env.HERSTEL_DROOG === "true";
const GEZONDHEID_PAD = path.join(__dirname, "..", "data", "bron-gezondheid.json");
const NIET_HERSTELBAAR = new Set(["ibabs"]);
const REPO_ROOT = path.join(__dirname, "..");

function git(...args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gh(...args) {
  return execFileSync("gh", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function leesGezondheid() {
  try {
    return JSON.parse(await fs.readFile(GEZONDHEID_PAD, "utf-8"));
  } catch {
    return {};
  }
}

const aantalLeeg = (gezondheid, id) => (gezondheid[id] && gezondheid[id].opeenvolgendGeenBerichten) || 0;
const aantalGeenVenster = (gezondheid, id) => (gezondheid[id] && gezondheid[id].opeenvolgendGeenBinnenVenster) || 0;

function aanleidingVoor(gezondheid, bron) {
  const leeg = aantalLeeg(gezondheid, bron.id);
  if (leeg >= MIN_DAGEN) return { soort: "leeg", aantal: leeg };
  const laatste = gezondheid[bron.id];
  const geenVenster = aantalGeenVenster(gezondheid, bron.id);
  const drempel = bron.rustig ? MIN_DAGEN_RUSTIG : MIN_DAGEN;
  if (laatste && laatste.gevonden > 0 && laatste.binnenVenster === 0 && geenVenster >= drempel) return { soort: "venster", aantal: geenVenster };
  return null;
}

function aanleidingTekst(bron, aanleiding, gezondheid) {
  if (aanleiding.soort === "venster") {
    const gevonden = (gezondheid[bron.id] && gezondheid[bron.id].gevonden) || 0;
    const venster = bron.soort === "agenda" ? "agenda-venster" : "leeftijdsvenster (maximaal 7 dagen oud)";
    return `leverde de laatste ${aanleiding.aantal} run(s) achter elkaar wel berichten op (${gevonden} in de laatste run), maar geen enkel bericht binnen het ${venster}${bron.rustig ? " (een rustige bron, daarom pas na een ruimere drempel gemeld)" : ""}`;
  }
  return `leverde ${aanleiding.aantal} run(s) achter elkaar geen enkel bericht op`;
}

function kiesDoelen(gezondheid, geforceerd) {
  const aanleidingen = {};
  const zetAanleiding = (b) => {
    aanleidingen[b.id] = aanleidingVoor(gezondheid, b) || { soort: "leeg", aantal: aantalLeeg(gezondheid, b.id) };
  };

  if (geforceerd && geforceerd !== "alle") {
    const bron = bronnen.find((b) => b.id === geforceerd);
    if (!bron) throw new Error(`Bron "${geforceerd}" staat niet in bronnen.js.`);
    zetAanleiding(bron);
    return { doelen: [bron], reden: `handmatig gekozen: ${geforceerd}`, aanleidingen };
  }
  if (geforceerd === "alle") {
    const doelen = bronnen.filter((b) => aantalLeeg(gezondheid, b.id) >= 1 || (gezondheid[b.id] && gezondheid[b.id].gevonden > 0 && gezondheid[b.id].binnenVenster === 0));
    doelen.forEach((b) => {
      const g = gezondheid[b.id];
      aanleidingen[b.id] = aantalLeeg(gezondheid, b.id) >= 1 ? { soort: "leeg", aantal: aantalLeeg(gezondheid, b.id) } : { soort: "venster", aantal: aantalGeenVenster(gezondheid, b.id) || 1 };
    });
    return { doelen, reden: "handmatig: alle bron
