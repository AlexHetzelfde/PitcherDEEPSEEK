const test = require("node:test");
const assert = require("node:assert/strict");
const { beoordeelJubileum, pasJubileumRoodToe } = require("../jubileum");
const runlog = require("../runlog");

const stil = { log() {}, error() {} };

const rood = (t) => {
  const o = beoordeelJubileum(t);
  return o && o.rood ? o.jaren : null;
};

test("50, 75 en 100 jaar met een jubileumwoord worden rood", () => {
  assert.equal(rood("Brandweer Oostzaan viert 100-jarig jubileum"), 100);
  assert.equal(rood("Zaans museum bestaat 75 jaar"), 75);
  assert.equal(rood("Voetbalvereniging viert 50 jaar bestaan met een feest"), 50);
  assert.equal(rood("Honderd jaar geleden werd de Zaanbrug geopend: herdenking"), 100);
  assert.equal(rood("Vijftig jaar jubileum van de Zaanse Schans"), 50);
  assert.equal(rood("Eeuwfeest in Wormerveer"), 100);
  assert.equal(rood("75 jaar bevrijding: herdenking op het plein"), 75);
});

test("andere jubileumjaren en losse jaargetallen worden niet rood", () => {
  assert.equal(beoordeelJubileum("Buurthuis viert 30 jaar bestaan"), null);
  assert.equal(beoordeelJubileum("Lezing: Tot Lering en Vermaak, 350 jaar"), null);
  assert.equal(beoordeelJubileum("Het museum bestaat 150 jaar"), null); // 150 is niet 50
  assert.equal(beoordeelJubileum("Wandelen voor 50 jaar en ouder"), null);
  assert.equal(beoordeelJubileum("Korting vanaf 50 jaar op het concert"), null);
  assert.equal(beoordeelJubileum("Dorpsfeest met 100 deelnemers"), null);
});

test("een kop in de vorm '50 jaar + naam' telt ook zonder jubileumwoord", () => {
  assert.equal(rood("Terug in de tijd: 50 jaar Koperen Bel"), 50);
  assert.equal(rood("100 jaar Zaanse Schans"), 100);
  assert.equal(beoordeelJubileum("Bakker heeft 50 jaar ervaring in het vak"), null); // kleine letter erna
});

test("50 jaar zonder jubileumwoord is geen jubileum", () => {
  assert.equal(beoordeelJubileum("Bakker heeft 50 jaar ervaring"), null);
  assert.equal(beoordeelJubileum("Nieuwe brug moet 100 jaar meegaan"), null);
});

test("huwelijken, dienstverband en leeftijden van personen zijn uitgesloten", () => {
  assert.equal(beoordeelJubileum("Echtpaar viert 50 jaar getrouwd").uitgesloten, "huwelijk");
  assert.equal(beoordeelJubileum("Gouden bruidspaar viert 50 jaar huwelijk").uitgesloten, "huwelijk");
  assert.equal(beoordeelJubileum("Wethouder viert 50 jaar in dienst bij de gemeente").uitgesloten, "dienstverband of lidmaatschap");
  assert.equal(beoordeelJubileum("Honderdjarige viert verjaardag").uitgesloten, "leeftijd van een persoon");
  assert.equal(beoordeelJubileum("100-jarige inwoner viert feest").uitgesloten, "leeftijd van een persoon");
});

test("de reden en het aantal jaren staan in de uitkomst", () => {
  const o = beoordeelJubileum("Brandweer Oostzaan viert 100-jarig jubileum");
  assert.equal(o.reden, "Jubileum: 100 jaar (100-jarig)");
});

test("pasJubileumRoodToe zet rood op nieuws en agenda en laat bestaand rood met rust", () => {
  const log = runlog.maakRunLog({ konsole: stil });
  const nu = new Date("2026-11-10T12:00:00Z");
  const records = [
    { id: "a", kop: "Zaans museum bestaat 75 jaar", bronTitel: "", eerstGezienOp: "2026-11-10T11:00:00Z" },
    { id: "b", kop: "Echtpaar viert 50 jaar getrouwd", eerstGezienOp: "2026-11-10T11:00:00Z" },
    { id: "c", kop: "Gewoon nieuws" },
    { id: "d", kop: "Vereniging viert 50 jaar bestaan", rood: { reden: "Groot onderwerp", route: "score" } },
  ];
  const agenda = [
    { id: "x", kop: "Brandweer Oostzaan viert 100-jarig jubileum", relevantie: { regel: "jubileum", woorden: "100-jarig jubileum" }, eerstGezienOp: "2026-10-01T00:00:00Z" },
    { id: "y", kop: "Buurtfeest", relevantie: { regel: "jubileum", woorden: "30 jaar" } },
  ];
  const uit = pasJubileumRoodToe({ records, agendaItems: agenda, nu, log });
  assert.equal(uit.records[0].rood.label, "jubileum 75 jaar");
  assert.equal(uit.records[0].rood.route, "regel");
  assert.equal(uit.records[1].rood, undefined); // huwelijk
  assert.equal(uit.records[2].rood, undefined);
  assert.equal(uit.records[3].rood.reden, "Groot onderwerp"); // blijft zoals het was
  assert.equal(uit.agendaItems[0].rood.label, "jubileum 100 jaar");
  assert.equal(uit.agendaItems[1].rood, undefined);
  assert.deepEqual(uit.stats, { nieuwsRood: 1, agendaRood: 1, uitgesloten: 1, alRood: 1 });
  const s = log.samenvatting().onderdelen.jubileum;
  assert.equal(s.tellers.uitgesloten, 1);
  assert.equal(s.regels.length, 1); // alleen het nieuwe nieuwsbericht; het agenda-item is al oud
  assert.equal(records[0].rood, undefined); // de invoer is niet aangepast
});

test("het jubileum van een agenda-item komt ook uit de woorden van het agendafilter", () => {
  const uit = pasJubileumRoodToe({
    records: [],
    agendaItems: [{ id: "z", kop: "Open dag", relevantie: { regel: "jubileum", woorden: "viert 75 jaar bestaan" } }],
    log: runlog.maakRunLog({ konsole: stil }),
  });
  assert.equal(uit.agendaItems[0].rood.label, "jubileum 75 jaar");
});
