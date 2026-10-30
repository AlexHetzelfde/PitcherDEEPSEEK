const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../agenda-regels");

const zichtbaar = (titel, tekst = "") => a.beoordeelAgendaRelevantie(titel, tekst, "eerste-of-jubileum").zichtbaar;

test("jubilea: 10, 20, 30, 25, 150 jaar en 12,5 jaar komen door", () => {
  for (const t of [
    "Tentoonstelling 150 jaar Noordzeekanaal",
    "10 jaar Zaans Cultuurhuis",
    "Feest voor 30 jaar buurthuis",
    "Concert 25 jaar Zaanse Kamerkoor",
    "De band bestaat 12,5 jaar",
    "20 jaar bestaan van de molen",
  ]) assert.equal(zichtbaar(t), true, t);
});

test("leeftijden zijn geen jubileum", () => {
  for (const t of [
    "Kinderworkshop voor kinderen van 10 jaar",
    "Workshop kinderen 4 - 10 jaar",
    "Theatervoorstelling vanaf 8 jaar",
    "Speurtocht leeftijd 10 jaar",
    "Spelletjesavond 7 jaar en ouder",
  ]) assert.equal(zichtbaar(t), false, t);
});

test("eerste keer en gewone avonden", () => {
  assert.equal(zichtbaar("Eerste editie Zaanse Bierfestival"), true);
  assert.equal(zichtbaar("Gewone avond met muziek"), false);
  assert.equal(a.beoordeelAgendaRelevantie("Gewone avond", "", "alles").zichtbaar, true);
});
