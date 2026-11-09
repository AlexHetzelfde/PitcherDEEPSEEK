"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../aanbesteding-regels");
const ted = require("../scrapers/ted");
const tn = require("../scrapers/tenderned");

test("gunning zonder winnaar en bedrag is 'zonder-gunning' (vuilniswagens), niet 'gegund'", () => {
  assert.strictEqual(R.soortVanTed({ noticeType: "can-standard", titel: "Huur Vuilniswagens", heeftWinnaar: false, heeftBedrag: false }), "zonder-gunning");
  assert.strictEqual(R.soortVanTed({ noticeType: "can-standard", titel: "X", heeftWinnaar: true }), "gunning");
  assert.strictEqual(R.soortVanTed({ noticeType: "can-social", titel: "X", heeftBedrag: true }), "gunning");
});

test("soorten uit TED notice-types", () => {
  const s = (t) => R.soortVanTed({ noticeType: t, titel: "X" });
  assert.strictEqual(s("cn-standard"), "aankondiging");
  assert.strictEqual(s("cn-social"), "aankondiging");
  assert.strictEqual(s("veat"), "voornemen-zonder-aanbesteding");
  assert.strictEqual(s("pin-only"), "vooraankondiging");
  assert.strictEqual(s("pmc"), "marktconsultatie");
  assert.strictEqual(s("can-modif"), "wijziging");
  assert.strictEqual(R.soortVanTed({ noticeType: "cn-standard", titel: "Opdracht ingetrokken" }), "ingetrokken");
});

test("koppen, titel en datum", () => {
  assert.strictEqual(R.schoneTitel("Nederland – Vuilniswagens – Huur Vuilniswagens"), "Huur Vuilniswagens");
  assert.strictEqual(R.bouwKop("gunning", "A", ["B BV"]), "Aanbesteding gegund aan B BV: A");
  assert.strictEqual(R.bouwKop("zonder-gunning", "A"), "Aanbesteding afgerond zonder gunning: A");
  assert.strictEqual(R.dagVan("2026-11-04+01:00"), "2026-11-04");
  assert.strictEqual(R.middernachtAmsterdam("2026-11-04"), "2026-11-03T23:00:00.000Z");
  assert.strictEqual(R.middernachtAmsterdam("2026-07-04"), "2026-07-03T22:00:00.000Z");
});

test("TED: lijst- en meertalige waarden", () => {
  assert.deepStrictEqual([...ted.alle({ nld: ["A BV", "B BV"], eng: ["A BV", "B BV"] })], ["A BV", "B BV"]);
  const p = ted.parseNotice({
    "publication-number": "1-2026",
    "notice-title": { nld: "Nederland – X – Huur", eng: "Netherlands" },
    "notice-type": "can-standard",
    "buyer-name": { nld: ["Gemeente Zaanstad"] },
    "publication-date": "2026-11-04+01:00",
    "procedure-identifier": "proc-1",
  });
  assert.strictEqual(p.soort, "zonder-gunning");
  assert.strictEqual(p.datum, "2026-11-04");
});

test("TED: groeperen per procedure geeft tijdlijn", () => {
  const mk = (nr, type, datum) => ted.parseNotice({ "publication-number": nr, "notice-title": "T", "notice-type": type, "buyer-name": "Zaanstad", "publication-date": datum, "procedure-identifier": "P" });
  const g = ted.groepeerPerProcedure([mk("2", "can-standard", "2026-11-04"), mk("1", "cn-standard", "2026-09-01")]);
  const lijst = [...g.values()][0];
  assert.deepStrictEqual(lijst.map((p) => p.nummer), ["1", "2"]);
  const b = ted.maakBericht({ id: "zaanstad-ted", naam: "n", categorie: "lokaal" }, lijst[1], lijst, new Date());
  assert.strictEqual(b.aanbesteding.tijdlijn.length, 2);
  assert.strictEqual(b.geenAi, true);
});

test("TenderNed: dienst kiezen en publicatie omzetten", () => {
  const d = tn.kiesDienst({ content: [{ id: 1, naam: "Zaanstad Wonen" }, { id: 2, naam: "Gemeente Zaanstad" }] }, "Zaanstad");
  assert.strictEqual(d.id, 2);
  assert.strictEqual(d.exact, true);
  assert.strictEqual(tn.kiesDienst({ content: [] }, "Zaanstad"), null);
  const p = tn.parsePublicatie({
    publicatieId: 99, aanbestedingNaam: "Onderhoud groen", opdrachtgeverNaam: "Gemeente Zaanstad",
    typePublicatie: { omschrijving: "Aankondiging van een opdracht" }, publicatieDatum: "2026-11-05", sluitingsDatum: "2026-12-01T12:00:00",
    link: { href: "https://api/x" },
  });
  assert.strictEqual(p.soort, "aankondiging");
  assert.strictEqual(p.url, "https://www.tenderned.nl/aankondigingen/overzicht/99");
  assert.strictEqual(p.sluitingsdatum, "2026-12-01");
  assert.strictEqual(tn.parsePublicatie({ publicatieId: 1, typePublicatie: { omschrijving: "Aankondiging van een gegunde opdracht" } }).soort, "gunning");
});

test("TenderNed-scraper met nagebootste fetch", async () => {
  const vandaag = new Date().toISOString().slice(0, 10);
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = String(url).includes("aanbestedendediensten")
      ? { content: [{ id: 7, naam: "Gemeente Zaanstad" }] }
      : { content: [{ publicatieId: 5, aanbestedingNaam: "Nieuw", typePublicatie: { omschrijving: "Aankondiging van een opdracht" }, publicatieDatum: vandaag }], totalElements: 1, last: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const log = console.log; console.log = () => {};
    const res = await tn.scrapeTenderned({ id: "zaanstad-tenderned", naam: "n", categorie: "lokaal", url: "https://x/v2" });
    console.log = log;
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].aanbesteding.bron, "tenderned");
  } finally { global.fetch = orig; }
});
