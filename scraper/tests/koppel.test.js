const test = require("node:test");
const assert = require("node:assert/strict");
const { koppelDossiers, sleutelsVan } = require("../koppel");

test("harde sleutels: adres, ECLI en zaaknummer", () => {
  const s = sleutelsVan("Aanvraag Annemoonstraat 30 in Zaandam, zie ECLI:NL:RBNHO:2026:1234 en zaaknummer ABC-2026-0042.");
  assert.ok(s.has("adres:annemoonstraat 30"));
  assert.ok(s.has("ecli:ECLI:NL:RBNHO:2026:1234"));
  assert.ok(s.has("zaak:ABC-2026-0042"));
  assert.equal([...sleutelsVan("Postcode 1506 MZ Zaandam")].length, 0); // een postcode alleen is te grof
});

test("een hoorzitting linkt aan het bericht, en een later bericht wordt de uitkomst", () => {
  const records = [
    { id: "b1-v1", groepId: "b1", versie: 1, kop: "Omgevingsvergunning Annemoonstraat 30", tijd: "2026-10-20T08:00:00Z" },
    { id: "b2-v1", groepId: "b2", versie: 1, kop: "Besluit over Annemoonstraat 30", tijd: "2026-11-10T08:00:00Z" },
    { id: "b3-v1", groepId: "b3", versie: 1, kop: "Los bericht over iets anders", tijd: "2026-10-21T08:00:00Z" },
  ];
  const agenda = [{ id: "a1", kop: "Hoorzitting Annemoonstraat 30", plaats: null, startDag: "2026-11-03", eindDag: "2026-11-03" }];
  const r = koppelDossiers(records, agenda);
  assert.equal(r.agendaItems[0].berichtId, "b1");
  assert.equal(r.agendaItems[0].gekoppeldVia, "sleutel");
  assert.equal(r.agendaItems[0].uitkomstId, "b2");
  assert.deepEqual(r.records.find((x) => x.groepId === "b1").gerelateerd, ["b2"]);
  assert.equal(r.records.find((x) => x.groepId === "b3").gerelateerd, undefined);
});

test("een oude sleutelkoppeling verdwijnt als de sleutel er niet meer is", () => {
  const records = [{ id: "b1-v1", groepId: "b1", versie: 1, kop: "Iets anders", tijd: "2026-10-20T08:00:00Z" }];
  const agenda = [{ id: "a1", kop: "Hoorzitting elders", berichtId: "b1", gekoppeldVia: "sleutel", uitkomstId: "x", startDag: "2026-11-03", eindDag: "2026-11-03" }];
  const r = koppelDossiers(records, agenda);
  assert.equal(r.agendaItems[0].berichtId, undefined);
  assert.equal(r.agendaItems[0].uitkomstId, undefined);
});
