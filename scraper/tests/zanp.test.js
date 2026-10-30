const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { tijdelijkeDataMap, leesData, geminiAntwoord } = require("./helpers");
const map = tijdelijkeDataMap(); // vóór het laden van zanp.js
const z = require("../zanp");
const g = require("../gemini");

const origineleFetch = global.fetch;
test.afterEach(() => { global.fetch = origineleFetch; });

const nu = new Date();
const ruw = (extra) => ({ bronNaam: "Bron", gepubliceerdOp: nu.toISOString(), ...extra });
const BRAND = ruw({
  bronId: "bekendmakingen",
  url: "https://voorbeeld.nl/brand",
  titel: "Uitslaande brand aan de Annemoonstraat 30",
  samenvatting: "Bij een uitslaande brand aan de Annemoonstraat 30 in Zaandam zijn 3 gewonden gevallen en zijn 12 bewoners geëvacueerd, meldt de brandweer vanochtend.",
});
const WETHOUDER = ruw({
  bronId: "DeOrkaan",
  url: "https://voorbeeld.nl/wethouder",
  titel: "Wethouder stapt op na integriteitsonderzoek",
  samenvatting: "De Zaanse wethouder stapt op na een integriteitsonderzoek naar het bestuur van de gemeente Zaanstad. De raad komt donderdag bijeen om erover te praten.",
});
const scrape = async () => [BRAND, WETHOUDER];
const geenTekst = async () => {};

test("quotumdag volgt de Amerikaanse westkust en de reset ligt in de toekomst", () => {
  const dag = z.quotumDag(new Date("2026-10-29T07:00:00Z")); // 00:00 PDT
  assert.equal(dag, "2026-10-29");
  assert.equal(z.quotumDag(new Date("2026-10-29T06:59:00Z")), "2026-10-28");
  const reset = z.volgendeQuotumReset(new Date("2026-10-29T10:00:00Z"));
  assert.equal(reset, "2026-10-30T07:00:00.000Z");
});

test("wachttijd na een 429: dagquotum tot de reset, anders de genoemde tijd", () => {
  const t = new Date("2026-10-29T10:00:00Z");
  assert.equal(z.wachtTotNaQuotum("HTTP 429: free tier, limit 20, per day. retry in 12h", t), "2026-10-30T07:00:00.000Z");
  assert.equal(z.wachtTotNaQuotum("HTTP 429: retry in 2m30s.", t), new Date(t.getTime() + 150000 + 60000).toISOString());
  assert.equal(z.wachtTotNaQuotum("HTTP 429", t), new Date(t.getTime() + 3600000).toISOString());
});

test("een bron die steeds leeg is komt minder vaak aan de beurt", () => {
  const snel = { id: "x", soort: "nieuws" };
  const min = (ms) => ms / 60000;
  assert.equal(min(z.bronInterval(snel, { opeenvolgendLeeg: 0 })), 25);
  assert.equal(min(z.bronInterval(snel, { opeenvolgendLeeg: 2 })), 25);
  assert.equal(min(z.bronInterval(snel, { opeenvolgendLeeg: 3 })), 50);
  assert.equal(min(z.bronInterval(snel, { opeenvolgendLeeg: 4 })), 100);
  assert.ok(min(z.bronInterval(snel, { opeenvolgendLeeg: 50 })) <= 360);
  assert.equal(min(z.bronInterval({ id: "y", rustig: true }, { opeenvolgendLeeg: 9 })), 20 * 60);
});

test("een run zonder API-sleutel levert tags, checklists en alleen de eigen bestanden", async () => {
  const r = await z.draai({ nu, apiKey: null, env: {}, scrape, haalTekst: geenTekst });
  const b = Object.fromEntries(r.records.map((x) => [x.bronId, x]));
  assert.equal(b.bekendmakingen.rubriek, "112");
  assert.equal(b.bekendmakingen.checklist.evacuatieOfNlAlert, true);
  assert.equal(b.DeOrkaan.checklist.bestuurlijkeCrisis, true);
  assert.deepEqual(fs.readdirSync(map).sort(), ["agenda.json", "berichten.json", "zanp-status.json"]); // geen pitchbestanden
  const status = leesData(map, "zanp-status.json");
  assert.equal(status.gemini.gebruikt, 0);
});

test("een run met AI telt verzoeken, bewaart de kwaliteit en kiest de tag", async () => {
  fs.rmSync(map, { recursive: true, force: true }); fs.mkdirSync(map);
  let aanroepen = 0;
  global.fetch = async (u, o) => {
    aanroepen++;
    const p = JSON.parse(o.body).contents[0].parts[0].text;
    const n = (p.match(/^BRON \d+:/gm) || []).length;
    const analyse = p.includes("Je analyseert");
    return geminiAntwoord({
      resultaten: Array.from({ length: n }, (_, i) =>
        analyse
          ? { nr: i + 1, tag: "GEM", checklist: { bestuurlijkeCrisis: true }, agendapunten: [] }
          : { nr: i + 1, kop: "Brand aan de Annemoonstraat 30 in Zaandam", tekst: "Bij een brand zijn 3 gewonden gevallen. 12 bewoners zijn geëvacueerd.", prio: 3, tag: "112", checklist: { gevaar: true, gewondenOfDoden: true, betrokkenen: 12 }, agendapunten: [] }
      ),
    });
  };
  const r = await z.draai({ nu, apiKey: "sleutel", env: {}, scrape, haalTekst: geenTekst, schrijf: g.schrijfMeldingen });
  assert.equal(aanroepen, 2); // één batch "volledig", één batch "analyse"
  const status = leesData(map, "zanp-status.json");
  assert.equal(status.gemini.gebruikt, 2);
  assert.equal(status.gemini.dag, z.quotumDag(nu));
  const dag = Object.values(status.kwaliteit)[0];
  assert.equal(dag.verzoeken, 2);
  assert.equal(dag.ok, 1);
  assert.equal(dag.analyseOk, 1);
  assert.equal(dag.tagAi, 2);
  const b = Object.fromEntries(r.records.map((x) => [x.bronId, x]));
  assert.equal(b.bekendmakingen.ai, true);
  assert.equal(b.bekendmakingen.tagBron, "ai");
  assert.equal(b.DeOrkaan.rubriek, "GEM");
  assert.equal(b.DeOrkaan.tekst, null); // andermans artikel wordt nooit herschreven
});

test("na een 429 wacht ZANP tot de quotumreset en slaat de AI daarna over", async () => {
  fs.rmSync(map, { recursive: true, force: true }); fs.mkdirSync(map);
  let aanroepen = 0;
  global.fetch = async () => { aanroepen++; return { ok: false, status: 429, json: async () => ({ error: { message: "free tier, limit 20, per day" } }) }; };
  await z.draai({ nu, apiKey: "sleutel", env: {}, scrape, haalTekst: geenTekst, schrijf: g.schrijfMeldingen });
  const eerste = aanroepen;
  assert.ok(eerste >= 1);
  const status = leesData(map, "zanp-status.json");
  assert.equal(status.gemini.gebruikt, 0); // een mislukt verzoek telt niet
  assert.ok(new Date(status.gemini.wachtTot) > nu);
  // Volgende run, een nieuw bericht: geen AI-aanroep meer.
  const NIEUW = ruw({ bronId: "bekendmakingen", url: "https://voorbeeld.nl/nieuw", titel: "Nieuw bericht", samenvatting: "x".repeat(200) });
  await z.draai({ nu: new Date(nu.getTime() + 1800000), apiKey: "sleutel", env: {}, scrape: async () => [NIEUW], haalTekst: geenTekst, schrijf: g.schrijfMeldingen });
  assert.equal(aanroepen, eerste);
  // Berichten blijven in de stroom, met tag en zonder AI.
  assert.ok(leesData(map, "berichten.json").berichten.length >= 3);
});

test("de dagcap (in verzoeken) wordt gerespecteerd", async () => {
  fs.rmSync(map, { recursive: true, force: true }); fs.mkdirSync(map);
  let aanroepen = 0;
  global.fetch = async (u, o) => { aanroepen++; const n = (JSON.parse(o.body).contents[0].parts[0].text.match(/^BRON \d+:/gm) || []).length; return geminiAntwoord({ resultaten: Array.from({ length: n }, (_, i) => ({ nr: i + 1, kop: "k", tekst: "t", prio: 3, checklist: {}, agendapunten: [] })) }); };
  const veel = Array.from({ length: 30 }, (_, i) => ruw({ bronId: "bekendmakingen", url: `https://voorbeeld.nl/${i}`, titel: `Bericht ${i}`, samenvatting: "y".repeat(200) }));
  await z.draai({ nu, apiKey: "sleutel", env: { ZANP_DAGCAP: "2", ZANP_RUNCAP: "5" }, scrape: async () => veel, haalTekst: geenTekst, schrijf: g.schrijfMeldingen });
  assert.equal(aanroepen, 2);
  assert.equal(leesData(map, "zanp-status.json").gemini.gebruikt, 2);
});

test("een oud bericht met een oude rubriekcode wordt omgezet naar een tag", () => {
  const oud = z.migreerBericht({ id: "a-v1", groepId: "a", url: "u", kop: "Rechtbank doet uitspraak", rubriek: "BES", bronId: "rechtspraak-noord-holland", herkomst: "officieel", gecontroleerdOp: "2026-10-01T00:00:00Z" });
  assert.equal(oud.rubriek, "REC");
  assert.ok(oud.tagBron);
  const agenda = z.migreerAgendaItem({ id: "x", kop: "Concert", rubriek: "BES", bronId: "zaans-museum", relevantie: { zichtbaar: true }, afkomst: "bron" });
  assert.equal(agenda.rubriek, "CUL");
});
