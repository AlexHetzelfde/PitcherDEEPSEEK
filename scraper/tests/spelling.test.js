const test = require("node:test");
const assert = require("node:assert/strict");
const spelling = require("../spelling");
const wire = require("../wire");
const runlog = require("../runlog");

const stil = { log() {}, error() {} };
const maakLog = () => runlog.maakRunLog({ konsole: stil });

// Een klein nepwoordenboek: alleen deze woorden zijn goed.
const GOED = new Set(
  ["inwoner", "stuurt", "brief", "gemeenteraad", "over", "planten", "sloop", "gemeente", "sluit", "zwembad", "fiets", "brug", "erg", "anders", "mail", "aan", "vraagt", "aandacht", "voor", "bij", "van", "college", "neemt", "besluiten"]
);
const SUGGESTIES = { inoner: ["Inwoner", "Winoner"], inonerende: ["Intonerende"], erganders: ["eilanders"] };
const nepWoordenboek = {
  correct: (w) => GOED.has(w.toLowerCase()),
  suggest: (w) => SUGGESTIES[w.toLowerCase()] || [],
};

test.beforeEach(() => spelling.zetWoordenboek(nepWoordenboek));
test.after(() => spelling.zetWoordenboek(null));

const BRON = "Mail Brief aan de gemeenteraad. Een inwoner stuurt een brief over het redden van planten bij sloop.";

test("een kop zonder onbekende woorden blijft zoals hij is", () => {
  const r = spelling.controleerKop("Inwoner stuurt brief over planten bij sloop", BRON, "Brontitel", maakLog());
  assert.equal(r.status, "ok");
  assert.equal(r.kop, "Inwoner stuurt brief over planten bij sloop");
});

test("een onbekend woord met een suggestie die in de bron staat wordt hersteld, met hoofdletter", () => {
  const log = maakLog();
  const r = spelling.controleerKop("Inoner stuurt brief over planten bij sloop", BRON, "Brontitel", log);
  assert.equal(r.status, "hersteld");
  assert.equal(r.kop, "Inwoner stuurt brief over planten bij sloop");
  const s = log.samenvatting().onderdelen.spelling;
  assert.equal(s.tellers.hersteld, 1);
  assert.equal(s.voorbeelden[0].fouten[0].woord, "Inoner");
});

test("een suggestie die niet in de bron staat wordt niet overgenomen: de kop valt terug", () => {
  const r = spelling.controleerKop("Inonerende brief vraagt aandacht", BRON, "Mail Brief aan de gemeenteraad", maakLog());
  assert.equal(r.status, "terugval");
  assert.equal(r.kop, "Mail Brief aan de gemeenteraad");
  assert.equal(r.fouten[0].woord, "Inonerende");
});

test("namen midden in de zin worden niet gecontroleerd, het eerste woord wel", () => {
  const okNaam = spelling.controleerKop("College neemt besluiten over Verkadevilla", BRON, "T", maakLog());
  assert.equal(okNaam.status, "ok");
  const eersteWoord = spelling.controleerKop("Verkadevilla krijgt een nieuwe bestemming", BRON, "T", maakLog());
  assert.equal(eersteWoord.status, "terugval");
});

test("afkortingen, merknamen, korte woorden en woorden uit de bron zijn goed", () => {
  const bron = "De EBS rijdt volgens iBabs met de busbrug.";
  const r = spelling.controleerKop("EBS en iBabs over busbrug", bron, "T", maakLog());
  assert.equal(r.status, "ok"); // EBS hoofdletters, iBabs merk, busbrug staat in de bron
});

test("een samenstelling van twee bekende woorden is goed, 'erganders' niet", () => {
  assert.equal(spelling.controleerKop("Fietsbrug sluit bij sloop", BRON, "T", maakLog()).status, "ok"); // fiets + brug
  const r = spelling.controleerKop("Gemeente sluit erganders zwembad", BRON, "T", maakLog());
  assert.equal(r.status, "terugval"); // erg (3 letters) + anders telt niet als samenstelling
});

test("zonder woordenboek verandert er niets en wordt het geteld", () => {
  spelling.zetWoordenboek(null);
  const log = maakLog();
  const r = spelling.controleerKop("Inoner stuurt brief", BRON, "T", log);
  assert.equal(r.status, "niet-gecontroleerd");
  assert.equal(r.kop, "Inoner stuurt brief");
  assert.equal(log.samenvatting().onderdelen.spelling.tellers.nietGecontroleerd, 1);
});

test("telTekstFouten telt alleen en verandert niets", () => {
  const log = maakLog();
  const n = spelling.telTekstFouten("Gemeente neemt erganders besluiten", BRON, log);
  assert.equal(n, 1);
  assert.equal(log.samenvatting().onderdelen.spelling.tellers.tekstenMetOnbekendWoord, 1);
});

test("verwerkMelding: een kop met onbekend woord valt terug op de brontitel en krijgt kopSpelling", () => {
  const nu = new Date();
  const b = {
    bronId: "bekendmakingen",
    bronNaam: "Bekendmakingen",
    url: "https://voorbeeld.nl/1",
    titel: "Gemeente sluit zwembad",
    samenvatting: "De gemeente sluit het zwembad aan de Vaart per 1 januari vanwege hoge kosten en weinig bezoekers in de afgelopen jaren, meldt de gemeente.",
    gepubliceerdOp: nu.toISOString(),
  };
  const plan = wire.planBerichten({ vensterBerichten: [b], nu }).nieuwe[0];
  const klaar = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit erganders zwembad", tekst: "De gemeente sluit het zwembad.", prio: 3, checklist: {}, agendapunten: [] },
  });
  assert.equal(klaar.kop, "Gemeente sluit zwembad"); // de brontitel
  assert.equal(klaar.kopSpelling, "terugval");
  assert.equal(klaar.ai, true); // de rest van de AI-uitvoer blijft gelden
});

test("verwerkMelding: een goede kop krijgt geen kopSpelling", () => {
  const nu = new Date();
  const b = {
    bronId: "bekendmakingen",
    bronNaam: "Bekendmakingen",
    url: "https://voorbeeld.nl/2",
    titel: "Gemeente sluit zwembad",
    samenvatting: "De gemeente sluit het zwembad aan de Vaart per 1 januari vanwege hoge kosten en weinig bezoekers in de afgelopen jaren, meldt de gemeente.",
    gepubliceerdOp: nu.toISOString(),
  };
  const plan = wire.planBerichten({ vensterBerichten: [b], nu }).nieuwe[0];
  const klaar = wire.verwerkMelding(plan, {
    melding: { kop: "Gemeente sluit zwembad aan de Vaart", tekst: "De gemeente sluit het zwembad.", prio: 3, checklist: {}, agendapunten: [] },
  });
  assert.equal(klaar.kop, "Gemeente sluit zwembad aan de Vaart");
  assert.equal(klaar.kopSpelling, undefined);
});

test("met het echte Nederlandse woordenboek: 'Inoner' wordt gevonden, gewone koppen niet", async () => {
  spelling.zetWoordenboek(null);
  assert.equal(await spelling.laad(maakLog()), true);
  assert.equal(spelling.isGeladen(), true);
  const bron = "Brief van een inwoner aan de gemeenteraad over het redden van planten bij sloop en circulair groenbeheer.";
  const fout = spelling.controleerKop("Inoner stuurt brief aan gemeenteraad", bron, "Brief", maakLog());
  assert.equal(fout.status, "hersteld");
  assert.equal(fout.kop, "Inwoner stuurt brief aan gemeenteraad");
  for (const goed of ["Gemeenteraad behandelt begroting in Zaandam", "Fietsbrug over de Zaan dicht voor onderhoud", "Vrijwillige brandweer Oostzaan bestaat 100 jaar"]) {
    assert.equal(spelling.controleerKop(goed, bron, "T", maakLog()).status, "ok", goed);
  }
});
