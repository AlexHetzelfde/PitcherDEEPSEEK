const test = require("node:test");
const assert = require("node:assert/strict");
const wire = require("../wire");

const nu = new Date();
const bron = (extra = {}) => ({
  bronId: "bekendmakingen",
  bronNaam: "Bekendmakingen",
  url: "https://voorbeeld.nl/1",
  titel: "Gewoon bericht",
  samenvatting: "x".repeat(200),
  gepubliceerdOp: nu.toISOString(),
  ...extra,
});

test("tag: AI wint, dan trefwoorden, dan de bron, dan Overig", () => {
  assert.deepEqual(wire.kiesTag({ kop: "Iets", aiTag: "SPO", standaard: "GEM" }), { tag: "SPO", bron: "ai" });
  assert.deepEqual(wire.kiesTag({ kop: "Iets", aiTag: "sport", standaard: "GEM" }), { tag: "SPO", bron: "ai" }); // naam geldt ook
  assert.equal(wire.kiesTag({ kop: "Uitslaande brand in woning", aiTag: "ZZZ", standaard: "GEM" }).tag, "112"); // ongeldige AI-tag
  assert.equal(wire.kiesTag({ kop: "Gewone kop", standaard: "REC" }).bron, "bron");
  assert.deepEqual(wire.kiesTag({ kop: "Gewone kop", standaard: "ALG" }), { tag: "ALG", bron: "geen" });
  assert.deepEqual(wire.kiesTag({ kop: "Gewone kop", aiTag: "ALG", standaard: "ALG" }), { tag: "ALG", bron: "geen" });
});

test("alle negen tags bestaan en onderwijs is er een van", () => {
  assert.deepEqual([...wire.TAG_CODES].sort(), ["112", "BED", "CUL", "GEM", "ONW", "PRV", "REC", "SPO", "VER"]);
  assert.equal(wire.kiesTag({ kop: "Nieuwe school voor 400 leerlingen in Zaandam" }).tag, "ONW");
});

test("zonder AI krijgt een nieuw bericht een tag, checklist en agendapunt uit patronen", () => {
  const b = bron({
    titel: "Uitslaande brand aan de Annemoonstraat 30",
    samenvatting:
      "Bij een uitslaande brand aan de Annemoonstraat 30 in Zaandam zijn 3 gewonden gevallen en zijn 12 bewoners geëvacueerd. " +
      "Er is een inloopavond op dinsdag 3 november om 19.30 uur in het buurthuis.",
  });
  const { nieuwe } = wire.planBerichten({ vensterBerichten: [b], nu });
  const r = nieuwe[0].record;
  assert.equal(r.rubriek, "112");
  assert.equal(r.tagBron, "trefwoord");
  assert.equal(r.checklistBron, "patroon");
  assert.equal(r.checklist.evacuatieOfNlAlert, true);
  assert.equal(r.checklist.gewondenOfDoden, true);
  assert.equal(r.checklist.betrokkenen, 12);
  assert.equal(r.checklist.tijdkritisch, true); // vers, met gevaarwoord
  assert.ok(r.agendapunten && r.agendapunten.length >= 1, "agendapunt uit tekst");
  assert.equal(r.agendapuntenBron, "patroon");
});

test("een patroon verzint geen getal dat niet in de bron staat", () => {
  const b = bron({ titel: "Raad bespreekt begroting", samenvatting: "De raad bespreekt de begroting van de gemeente en de plannen voor het komende jaar in de raadzaal van het stadhuis." });
  const r = wire.planBerichten({ vensterBerichten: [b], nu }).nieuwe[0].record;
  assert.equal(r.checklist.betrokkenen, null);
  assert.equal(r.checklist.geldbedragEuro, null);
  assert.equal(r.checklist.gevaar, false);
});

test("verwerkMelding: een geldige AI-tag wint en vervangt de patroonversie", () => {
  const b = bron({ titel: "Gemeente sluit zwembad", samenvatting: "De gemeente sluit het zwembad aan de Vaart per 1 januari vanwege hoge kosten van 2,5 miljoen euro en weinig bezoekers in de afgelopen jaren." });
  const plan = wire.planBerichten({ vensterBerichten: [b], nu }).nieuwe[0];
  assert.ok(plan.invoer, "AI-invoer aanwezig");
  const klaar = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit zwembad aan de Vaart", tekst: "De gemeente sluit het zwembad per 1 januari.", prio: 3, tag: "SPO", checklist: { besluitMetGrootGevolg: true }, agendapunten: [] },
  });
  assert.equal(klaar.rubriek, "SPO");
  assert.equal(klaar.tagBron, "ai");
  assert.equal(klaar.checklistBron, "ai");
  assert.equal(klaar.ai, true);
  assert.equal(klaar.agendapuntenBron, undefined);
});

test("verwerkMelding: een afgekeurde AI-uitvoer behoudt de patronen en tag van de code", () => {
  const b = bron({ titel: "Brand bij fabriek", samenvatting: "Bij een grote brand bij een fabriek in Zaandam zijn 4 gewonden gevallen, meldt de brandweer. De hulpdiensten zijn massaal aanwezig." });
  const plan = wire.planBerichten({ vensterBerichten: [b], nu }).nieuwe[0];
  const fout = wire.verwerkMelding(plan, { fout: "HTTP 429" });
  assert.equal(fout.controle, "ai-fout");
  assert.equal(fout.rubriek, "112");
  assert.equal(fout.checklistBron, "patroon");
  const cijfers = wire.verwerkMelding(plan, { melding: { kop: "Brand met 99 gewonden", tekst: "99 gewonden.", prio: 2, checklist: {}, agendapunten: [] } });
  assert.equal(cijfers.controle, "cijfers-afgekeurd");
});

test("volgorde voor de AI: belangrijk en wire eerst, routine laatst", () => {
  const n = (id, prio, herkomst, tijd) => ({ record: { id, prio, herkomst, tijd } });
  const lijst = [
    n("routine-bekendmaking", 4, "officieel", "2026-10-29T10:00:00Z"),
    n("organisatie-routine", 4, "organisatie", "2026-10-29T11:00:00Z"),
    n("signaal-oud", 3, "signaal", "2026-10-29T08:00:00Z"),
    n("officieel-prio3", 3, "officieel", "2026-10-29T09:00:00Z"),
    n("signaal-nieuw", 3, "signaal", "2026-10-29T12:00:00Z"),
  ];
  const volgorde = wire.sorteerVoorAI(lijst).map((x) => x.record.id);
  assert.deepEqual(volgorde, ["signaal-nieuw", "officieel-prio3", "signaal-oud", "routine-bekendmaking", "organisatie-routine"]);
  assert.equal(lijst[0].record.id, "routine-bekendmaking"); // invoer niet gewijzigd
});
