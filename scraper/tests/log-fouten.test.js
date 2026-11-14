// Tests voor het foutenlogboek van ZANP (14 nov 2026):
//  - een bron die een fout geeft, is te onderscheiden van een bron zonder nieuws
//  - de reden van een mislukte AI-aanroep komt in zanp-log.json
//  - de statusregel van een verwijderde bron wordt opgeruimd
//  - de rubrieken-controle kent bronnen.js en zanp-bronnen.js samen
// Geen echt netwerk: alleen een lokale testserver op dit apparaat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { tijdelijkeDataMap, leesData, geminiAntwoord } = require("./helpers");
const map = tijdelijkeDataMap(); // vóór het laden van zanp.js
const z = require("../zanp");
const gedeeld = require("../gedeeld");
const { valideer } = require("../valideer-rubrieken");
const bronnenLijst = [...require("../bronnen"), ...require("../zanp-bronnen")];

const origineleFetch = global.fetch;
test.afterEach(() => {
  global.fetch = origineleFetch;
});

const nu = new Date();
const ruw = (extra) => ({ bronNaam: "Bron", gepubliceerdOp: nu.toISOString(), ...extra });
const BRAND = ruw({
  bronId: "bekendmakingen",
  url: "https://voorbeeld.nl/brand",
  titel: "Uitslaande brand aan de Annemoonstraat 30",
  samenvatting:
    "Bij een uitslaande brand aan de Annemoonstraat 30 in Zaandam zijn 3 gewonden gevallen en zijn 12 bewoners geëvacueerd, meldt de brandweer vanochtend.",
});
const WETHOUDER = ruw({
  bronId: "DeOrkaan",
  url: "https://voorbeeld.nl/wethouder",
  titel: "Wethouder stapt op na integriteitsonderzoek",
  samenvatting:
    "De Zaanse wethouder stapt op na een integriteitsonderzoek naar het bestuur van de gemeente Zaanstad. De raad komt donderdag bijeen om erover te praten.",
});
const HHNK_BERICHT = ruw({
  bronId: "nh-cultuur",
  url: "https://voorbeeld.nl/nh-cultuur",
  titel: "Hoogheemraadschap legt nieuwe dijkwacht aan",
  samenvatting: "Het hoogheemraadschap legt een nieuwe dijkwacht aan langs de Zaan, melden de bestuurders.",
});
const geenTekst = async () => {};

const schoneMap = () => {
  fs.rmSync(map, { recursive: true, force: true });
  fs.mkdirSync(map);
};
const laatsteLog = (onderdeel) => leesData(map, "zanp-log.json").runs.at(-1).onderdelen[onderdeel];

// ---------------------------------------------------------------------------
// gedeeld.js: de optionele terugmelding
// ---------------------------------------------------------------------------

test("scrapeAlleBronnen meldt een mislukte bron via opFout; zonder die optie verandert er niets", async () => {
  // Een server die verbinding maakt maar nooit antwoordt: de bron loopt dus op de tijdslimiet.
  const server = http.createServer(() => {});
  await new Promise((klaar) => server.listen(0, "127.0.0.1", klaar));
  const bron = { id: "traag", naam: "Traag", categorie: "lokaal", type: "rss", url: `http://127.0.0.1:${server.address().port}/feed` };
  try {
    const meldingen = [];
    const metMelding = await gedeeld.scrapeAlleBronnen([bron], {
      parallel: 2,
      timeoutMs: 300,
      opFout: (b, fout, duurSec) => meldingen.push({ id: b.id, bericht: fout.message, duurSec }),
    });
    assert.deepEqual(metMelding, [], "een mislukte bron levert een lege lijst op, zoals altijd");
    assert.equal(meldingen.length, 1);
    assert.equal(meldingen[0].id, "traag");
    assert.match(meldingen[0].bericht, /^time-out/);
    assert.equal(typeof meldingen[0].duurSec, "number");

    // Zoals de pitchrun het aanroept: geen opFout, zelfde uitkomst.
    const zonderMelding = await gedeeld.scrapeAlleBronnen([bron], { parallel: 2, timeoutMs: 300 });
    assert.deepEqual(zonderMelding, []);

    // Een opFout die zelf crasht, mag het scrapen nooit stoppen.
    const metKapotteMelding = await gedeeld.scrapeAlleBronnen([bron], {
      timeoutMs: 300,
      opFout: () => {
        throw new Error("kapotte logfunctie");
      },
    });
    assert.deepEqual(metKapotteMelding, []);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---------------------------------------------------------------------------
// zanp.js: scrapefouten in status en logboek
// ---------------------------------------------------------------------------

test("een bron met een fout is in status en logboek te onderscheiden van een bron zonder nieuws", async () => {
  schoneMap();
  const mislukt = async (lijst, opties) => {
    const kapot = lijst.find((b) => b.id === "nh-cultuur");
    assert.ok(kapot, "nh-cultuur hoort aan de beurt te zijn");
    opties.opFout(kapot, new Error("time-out na 45.0s bij nh-cultuur"), 45);
    return [BRAND];
  };
  const env = { ZANP_ALLES: "1" };

  await z.draai({ nu, apiKey: null, env, scrape: mislukt, haalTekst: geenTekst });
  let status = leesData(map, "zanp-status.json");
  assert.equal(status.bronnen["nh-cultuur"].gevonden, 0);
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendLeeg, 1);
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendFout, 1);
  assert.match(status.bronnen["nh-cultuur"].laatsteFout.bericht, /time-out/);
  assert.equal(status.bronnen["nh-cultuur"].laatsteFout.duurSec, 45);
  assert.equal(status.bronnen.bekendmakingen.opeenvolgendFout, 0, "een bron die werkt heeft geen fouten");
  assert.equal(status.bronnen.bekendmakingen.laatsteFout, undefined);
  assert.equal(status.bronnen["zaans-museum"].opeenvolgendLeeg, 1, "een rustige bron is wel leeg");
  assert.equal(status.bronnen["zaans-museum"].opeenvolgendFout, 0, "maar geen fout");

  let bronnenLog = laatsteLog("bronnen");
  assert.equal(bronnenLog.tellers.fout, 1);
  assert.equal(bronnenLog.tellers.timeOut, 1);
  assert.ok(bronnenLog.waarden.leegZonderFoutLijst.includes("zaans-museum"));
  assert.ok(!bronnenLog.waarden.leegZonderFoutLijst.includes("nh-cultuur"), "een bron met een fout is niet 'gewoon leeg'");
  assert.ok(!bronnenLog.waarden.leegZonderFoutLijst.includes("bekendmakingen"));
  assert.ok(bronnenLog.regels.some((r) => r.includes("[nh-cultuur]") && r.includes("time-out")));
  assert.equal(bronnenLog.voorbeelden[0].bron, "nh-cultuur");

  // Dezelfde fout een uur later: de teller loopt door.
  await z.draai({ nu: new Date(nu.getTime() + 3600e3), apiKey: null, env, scrape: mislukt, haalTekst: geenTekst });
  status = leesData(map, "zanp-status.json");
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendFout, 2);
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendLeeg, 2);

  // Daarna werkt de bron weer: de foutenreeks stopt, de laatste fout blijft zichtbaar.
  const hersteld = async () => [BRAND, HHNK_BERICHT];
  await z.draai({ nu: new Date(nu.getTime() + 2 * 3600e3), apiKey: null, env, scrape: hersteld, haalTekst: geenTekst });
  status = leesData(map, "zanp-status.json");
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendFout, 0);
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendLeeg, 0);
  assert.match(status.bronnen["nh-cultuur"].laatsteFout.bericht, /time-out/, "de laatste fout blijft staan als geschiedenis");
  bronnenLog = laatsteLog("bronnen");
  assert.equal(bronnenLog.tellers.fout, 0);
});

test("een scraper die zijn eigen fout opvangt (console.error, lege lijst) telt als mislukte bron", async () => {
  schoneMap();
  const echteConsoleError = console.error;
  const stil = [];
  const scrapeMetEigenFout = async () => {
    // Zoals generieke-lijst.js: fout opvangen, loggen, lege lijst teruggeven.
    console.error("[nh-cultuur] Generieke lijst-scraper mislukt: fetch failed — oorzaak: getaddrinfo ENOTFOUND www.nh-cultuur.nl [ENOTFOUND]");
    // Een foutregel naast gevonden berichten is een melding, geen mislukte bron.
    console.error("[bekendmakingen] Detailpagina niet op te halen: 500");
    // Waarschuwingen en gewone regels tellen niet mee.
    console.warn("[zaans-museum] Sessie ophalen mislukt — doorgaan zonder cookie.");
    console.log("[zaans-museum] Feed-kandidaat faalde: 404");
    return [BRAND];
  };
  console.error = (...a) => stil.push(a.join(" ")); // houd de testuitvoer schoon
  try {
    await z.draai({ nu, apiKey: null, env: { ZANP_ALLES: "1" }, scrape: scrapeMetEigenFout, haalTekst: geenTekst });
  } finally {
    console.error = echteConsoleError;
  }
  assert.ok(stil.some((r) => r.includes("[nh-cultuur]")), "de regel gaat ook gewoon naar de echte console");

  const status = leesData(map, "zanp-status.json");
  assert.equal(status.bronnen["nh-cultuur"].opeenvolgendFout, 1);
  assert.match(status.bronnen["nh-cultuur"].laatsteFout.bericht, /^Generieke lijst-scraper mislukt: fetch failed/);
  assert.equal(status.bronnen["nh-cultuur"].laatsteFout.duurSec, null);
  assert.equal(status.bronnen.bekendmakingen.opeenvolgendFout, 0, "met berichten is het geen mislukte bron");
  assert.equal(status.bronnen["zaans-museum"].opeenvolgendFout, 0, "een waarschuwing is geen fout");

  const log = laatsteLog("bronnen");
  assert.equal(log.tellers.fout, 1);
  assert.equal(log.tellers.meldingMetBerichten, 1);
  assert.ok(log.waarden.leegZonderFoutLijst.includes("zaans-museum"));
  assert.ok(!log.waarden.leegZonderFoutLijst.includes("nh-cultuur"));
  assert.ok(log.regels.some((r) => r.startsWith("[nh-cultuur] scrapen mislukt") && r.includes("ENOTFOUND")));
});

test("vangBronFouten zet console.error altijd terug, ook als het werk een fout gooit", async () => {
  const voor = console.error;
  await assert.rejects(
    z.vangBronFouten(new Set(["x"]), async () => {
      throw new Error("kapot");
    }),
    /kapot/
  );
  assert.equal(console.error, voor);
});

test("de statusregel van een bron die uit de lijsten is gehaald, wordt opgeruimd", async () => {
  schoneMap();
  fs.writeFileSync(
    path.join(map, "zanp-status.json"),
    JSON.stringify({
      bronnen: {
        "verwijderde-bron": { laatsteScrape: "2026-10-01T00:00:00.000Z", gevonden: 0, opeenvolgendLeeg: 60 },
        bekendmakingen: { laatsteScrape: "2026-10-01T00:00:00.000Z", gevonden: 3, opeenvolgendLeeg: 0 },
      },
    })
  );
  await z.draai({ nu, apiKey: null, env: { ZANP_ALLES: "1" }, scrape: async () => [BRAND], haalTekst: geenTekst });
  const status = leesData(map, "zanp-status.json");
  assert.equal(status.bronnen["verwijderde-bron"], undefined, "anders blijft de site 'bronnen leverden niets op' melden");
  assert.ok(status.bronnen.bekendmakingen, "een bron die nog bestaat blijft");
  assert.equal(laatsteLog("bronnen").tellers.statusOpgeruimd, 1);
});

// ---------------------------------------------------------------------------
// zanp.js: de reden van AI-fouten
// ---------------------------------------------------------------------------

test("aiFoutCategorie deelt de bekende foutmeldingen in", () => {
  const c = z.aiFoutCategorie;
  assert.equal(c({ fout: "HTTP 503: The model is overloaded.", status: 503 }), "http-503");
  assert.equal(c({ fout: "HTTP 429: quota", status: 429 }), "http-429");
  assert.equal(c({ fout: "leeg antwoord (finishReason: MAX_TOKENS)" }), "leeg-antwoord");
  assert.equal(c({ fout: "antwoord is geen geldige JSON" }), "ongeldig-json");
  assert.equal(c({ fout: "ontbreekt in het antwoord" }), "ontbreekt-in-antwoord");
  assert.equal(c({ fout: "onvolledige melding (kop ontbreekt)" }), "onvolledig");
  assert.equal(c({ fout: "onvolledige analyse (checklist ontbreekt)" }), "onvolledig");
  assert.equal(c({ fout: "alle modellen faalden" }), "alle-modellen-faalden");
  assert.equal(c({ fout: "This operation was aborted" }), "time-out");
  assert.equal(c({ fout: "iets heel anders" }), "overig");
  assert.equal(c({}), "overig");
});

test("een mislukte AI-aanroep komt met de volledige reden in het logboek", async () => {
  schoneMap();
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: { message: "The model is overloaded. Please try again later." } }),
  });
  await z.draai({ nu, apiKey: "test-sleutel", env: {}, scrape: async () => [BRAND, WETHOUDER], haalTekst: geenTekst });

  const berichten = leesData(map, "berichten.json").berichten;
  assert.ok(berichten.some((b) => b.controle === "ai-fout"), "de berichten krijgen ai-fout, zoals altijd");
  const ai = laatsteLog("ai");
  assert.ok(ai.tellers["fout-http-503"] >= 1);
  assert.ok(ai.regels.some((r) => r.includes("http-503") && r.includes("overloaded")), "de reden staat in een regel");
  assert.equal(ai.voorbeelden[0].categorie, "http-503");
  assert.equal(ai.voorbeelden[0].status, 503);
  assert.ok(["bekendmakingen", "DeOrkaan"].includes(ai.voorbeelden[0].bron));
});

test("een antwoord waarin een bericht ontbreekt, staat als 'ontbreekt-in-antwoord' in het logboek", async () => {
  schoneMap();
  global.fetch = async () => geminiAntwoord({ resultaten: [] }); // geldig antwoord, maar zonder resultaten
  await z.draai({ nu, apiKey: "test-sleutel", env: {}, scrape: async () => [BRAND, WETHOUDER], haalTekst: geenTekst });
  const ai = laatsteLog("ai");
  assert.ok(ai.tellers["fout-ontbreekt-in-antwoord"] >= 1);
  assert.ok(ai.regels.some((r) => r.includes("ontbreekt-in-antwoord")));
});

test("zonder AI-fouten komt er ook geen AI-onderdeel met fouten in het logboek", async () => {
  schoneMap();
  await z.draai({ nu, apiKey: null, env: {}, scrape: async () => [BRAND], haalTekst: geenTekst });
  const onderdelen = leesData(map, "zanp-log.json").runs.at(-1).onderdelen;
  assert.equal(onderdelen.ai, undefined);
});

// ---------------------------------------------------------------------------
// valideer-rubrieken.js
// ---------------------------------------------------------------------------

test("rubrieken.json en de twee bronnenlijsten komen overeen", () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rubrieken.json"), "utf-8"));
  const { fouten, waarschuwingen } = valideer(data, bronnenLijst);
  assert.deepEqual(fouten, []);
  assert.deepEqual(waarschuwingen, [], "elke bron heeft een regel en elke regel een bron");
});

test("het script valideer-rubrieken.js leest beide bronnenlijsten", () => {
  const uit = execFileSync(process.execPath, [path.join(__dirname, "..", "valideer-rubrieken.js")], { encoding: "utf-8" });
  assert.ok(!uit.includes("::warning"), `onverwachte waarschuwing:\n${uit}`);
  assert.match(uit, /rubrieken\.json is in orde/);
});
