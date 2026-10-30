const test = require("node:test");
const assert = require("node:assert/strict");
const { geminiAntwoord } = require("./helpers");
const g = require("../gemini");

const maak = (n, modus = "volledig") =>
  Array.from({ length: n }, (_, i) => ({ id: `${modus}${i}`, modus, titel: `Titel ${i}`, tekst: "x".repeat(100), bronNaam: "B", gepubliceerdOp: "2026-10-29" }));
const goed = { kop: "kop", tekst: "tekst", prio: 3, tag: "GEM", checklist: { gevaar: false }, agendapunten: [] };
const origineleFetch = global.fetch;
test.afterEach(() => { global.fetch = origineleFetch; });

function antwoordVoorBatch(_url, opties) {
  const prompt = JSON.parse(opties.body).contents[0].parts[0].text;
  const n = (prompt.match(/^BRON \d+:/gm) || []).length;
  const analyse = prompt.includes("Je analyseert");
  return geminiAntwoord({
    resultaten: Array.from({ length: n }, (_, i) =>
      analyse ? { nr: i + 1, tag: "REC", checklist: { gevaar: true }, agendapunten: [] } : { nr: i + 1, ...goed }
    ),
  });
}

test("de pitchrun blijft op Flash, ZANP op Flash-Lite", () => {
  assert.deepEqual(g.MODELLEN.filter, ["gemini-flash-latest"]);
  assert.deepEqual(g.MODELLEN.pitch, ["gemini-flash-latest"]);
  assert.deepEqual(g.MODELLEN.sterker, ["gemini-flash-latest"]);
  assert.deepEqual(g.MODELLEN.wire, ["gemini-flash-lite-latest"]);
});

test("16 berichten kosten 4 verzoeken: batches per modus", async () => {
  let aanroepen = 0;
  global.fetch = async (u, o) => { aanroepen++; return antwoordVoorBatch(u, o); };
  const items = [...maak(13), ...maak(3, "analyse")];
  const r = await g.schrijfMeldingen(items, "sleutel", 10, { tags: [{ code: "GEM", naam: "Gemeente", hint: "raad" }] });
  assert.equal(aanroepen, 4);
  assert.equal(r.verzoeken, 4);
  assert.equal([...r.values()].filter((x) => x.melding).length, 16);
  assert.equal(r.get("volledig0").melding.tag, "GEM");
  assert.equal(r.get("analyse0").melding.tag, "REC");
});

test("de cap is een aantal verzoeken", async () => {
  global.fetch = async (u, o) => antwoordVoorBatch(u, o);
  const r = await g.schrijfMeldingen(maak(20), "sleutel", 2);
  assert.equal(r.verzoeken, 2);
  assert.equal([...r.values()].filter((x) => x.melding).length, 12);
  assert.equal([...r.values()].filter((x) => /overgeslagen \(cap/.test(x.fout || "")).length, 8);
});

test("een deels ontbrekend of onvolledig antwoord blijft per bericht bruikbaar", async () => {
  global.fetch = async () => geminiAntwoord({ resultaten: [{ nr: 1, ...goed }, { nr: 3, kop: "", tekst: "" }] });
  const r = await g.schrijfMeldingen(maak(4), "sleutel", 5);
  assert.ok(r.get("volledig0").melding);
  assert.match(r.get("volledig1").fout, /ontbreekt/);
  assert.match(r.get("volledig2").fout, /onvolledig/);
  assert.match(r.get("volledig3").fout, /ontbreekt/);
});

test("bij een 429 starten er geen nieuwe verzoeken meer", async () => {
  let aanroepen = 0;
  global.fetch = async () => { aanroepen++; return { ok: false, status: 429, json: async () => ({ error: { message: "quota. Please retry in 12h3m." } }) }; };
  const r = await g.schrijfMeldingen(maak(60), "sleutel", 20);
  assert.ok(aanroepen <= 3, `er waren ${aanroepen} aanroepen`);
  assert.equal(r.verzoeken, 0); // een 429 telt niet mee
  assert.ok([...r.values()].some((x) => x.status === 429));
  assert.ok([...r.values()].some((x) => /quotum bereikt/.test(x.fout || "")));
});

test("dubbel nieuws: 10 paren per verzoek, en een 429 wordt gemeld", async () => {
  global.fetch = async (u, o) => {
    const prompt = JSON.parse(o.body).contents[0].parts[0].text;
    const n = (prompt.match(/^PAAR \d+/gm) || []).length;
    return geminiAntwoord({ antwoorden: Array.from({ length: n }, (_, i) => ({ nr: i + 1, zelfde: i % 2 === 0 })) });
  };
  const paren = Array.from({ length: 23 }, (_, i) => ({ sleutel: `s${i}`, a: { titel: "a" }, b: { titel: "b" } }));
  const z = await g.beslisZelfdeNieuwsfeit(paren, "sleutel", 5);
  assert.equal(z.verzoeken, 3);
  assert.equal([...z.values()].filter((v) => v === null).length, 0);
  assert.equal(z.quotum, false);

  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "per day" } }) });
  const k = await g.beslisZelfdeNieuwsfeit(paren, "sleutel", 5);
  assert.equal(k.quotum, true);
  assert.match(k.quotumTekst, /429/);
});

test("de prompt bevat de tags en genummerde bronnen", () => {
  const p = g.bouwMeldingBatchPrompt(maak(2), "volledig", [{ code: "112", naam: "112", hint: "brand" }]);
  assert.match(p, /TAG \(kies precies één code/);
  assert.match(p, /BRON 2:/);
});
