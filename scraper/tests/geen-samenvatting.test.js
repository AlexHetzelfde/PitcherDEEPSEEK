// Stap 6 (2026-11-11): de AI schrijft geen samenvatting meer, alleen een kop,
// prio, tag, checklist en agendapunten. De popup toont de volledige tekst.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../gemini");
const wire = require("../wire");
const spelling = require("../spelling");

const nu = new Date();
const bron = (extra = {}) => ({
  bronId: "bekendmakingen",
  bronNaam: "Bekendmakingen",
  url: "https://voorbeeld.nl/geen-samenvatting",
  titel: "Gemeente sluit zwembad",
  samenvatting: "De gemeente sluit het zwembad aan de Vaart per 1 januari vanwege hoge kosten en weinig bezoekers in de afgelopen jaren, meldt de gemeente.",
  gepubliceerdOp: nu.toISOString(),
  ...extra,
});

test.beforeEach(() => spelling.zetWoordenboek(null));

test("de prompt vraagt in modus volledig geen tekst en zegt dat er geen samenvatting komt", () => {
  const items = [{ id: "a", modus: "volledig", titel: "T", tekst: "x".repeat(100), bronNaam: "B", gepubliceerdOp: "2026-11-11" }];
  const prompt = g.bouwMeldingBatchPrompt(items, "volledig", []);
  assert.ok(prompt.includes("Je schrijft geen samenvatting"));
  assert.ok(!/"tekst":/.test(prompt), "het JSON-voorbeeld heeft geen tekstveld");
  assert.ok(!prompt.includes("twee tot vier zinnen"));
  assert.ok(prompt.includes('"kop": "..."'));
  assert.ok(prompt.includes('"prio": 3'));
  assert.ok(prompt.includes('"checklist"') || prompt.includes("checklist"));
});

test("een melding zonder tekst is geldig; een meegestuurde tekst wordt genegeerd", () => {
  const goed = { kop: "Gemeente sluit zwembad", prio: 3, tag: "GEM", checklist: { gevaar: false }, agendapunten: [] };
  const zonder = g.valideerMelding(goed, "volledig");
  assert.equal(zonder.kop, "Gemeente sluit zwembad");
  assert.equal(zonder.prio, 3);
  assert.equal("tekst" in zonder, false);
  const metTekst = g.valideerMelding({ ...goed, tekst: "Een samenvatting die we niet meer willen." }, "volledig");
  assert.equal("tekst" in metTekst, false);
});

test("zonder kop is een melding nog steeds onbruikbaar", () => {
  assert.equal(g.valideerMelding({ kop: "", prio: 3, checklist: {}, agendapunten: [] }, "volledig"), null);
  assert.equal(g.valideerMelding({ prio: 3, checklist: {}, agendapunten: [] }, "volledig"), null);
});

test("de promptversie is veranderd, zodat het log laat zien welke prompt draaide", () => {
  assert.equal(g.PROMPT_VERSIE_WIRE, "2026-11-11-batch-kop-tag-checklist-agendapunten");
});

test("verwerkMelding bewaart geen samenvatting en wist een oude", () => {
  const plan = wire.planBerichten({ vensterBerichten: [bron()], nu }).nieuwe[0];
  plan.record.tekst = "Een oude samenvatting van een eerdere promptversie.";
  const klaar = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit zwembad aan de Vaart", prio: 3, tag: "GEM", checklist: {}, agendapunten: [] },
  });
  assert.equal(klaar.tekst, null);
  assert.equal(klaar.kop, "Gemeente sluit zwembad aan de Vaart");
  assert.equal(klaar.ai, true);
  assert.equal(klaar.controle, "cijfers-ok");
});

test("de cijfercontrole gaat over de kop: een getal in de kop dat niet in de bron staat wordt afgekeurd", () => {
  const plan = wire.planBerichten({ vensterBerichten: [bron({ url: "https://voorbeeld.nl/cijfers" })], nu }).nieuwe[0];
  const fout = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit 7 zwembaden", prio: 3, checklist: {}, agendapunten: [] },
  });
  assert.equal(fout.controle, "cijfers-afgekeurd");
  assert.equal(fout.kop, "Gemeente sluit zwembad"); // de originele kop blijft
});

test("een getal in een eventueel meegestuurde tekst telt niet meer mee", () => {
  const plan = wire.planBerichten({ vensterBerichten: [bron({ url: "https://voorbeeld.nl/tekst-negeren" })], nu }).nieuwe[0];
  const klaar = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit zwembad aan de Vaart", tekst: "Er vielen 99 gewonden.", prio: 3, checklist: {}, agendapunten: [] },
  });
  assert.equal(klaar.controle, "cijfers-ok");
  assert.equal(klaar.tekst, null);
});
