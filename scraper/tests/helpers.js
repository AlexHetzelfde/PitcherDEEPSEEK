// Gedeelde hulpmiddelen voor de tests. Geen netwerk, en de echte data-map
// blijft onaangeroerd: ZANP_DATA_DIR wijst naar een tijdelijke map.
const fs = require("fs");
const os = require("os");
const path = require("path");

function tijdelijkeDataMap() {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "zanp-test-"));
  process.env.ZANP_DATA_DIR = map;
  return map;
}

function leesData(map, naam) {
  return JSON.parse(fs.readFileSync(path.join(map, naam), "utf-8"));
}

// Een nep-antwoord van de Gemini-API.
function geminiAntwoord(obj) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) };
}

module.exports = { tijdelijkeDataMap, leesData, geminiAntwoord };
