const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const arch = require("../tekstarchief");
const runlog = require("../runlog");

const stil = { log() {}, error() {} };
const maakLog = () => runlog.maakRunLog({ konsole: stil });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "zanp-teksten-"));
const VANDAAG = "2026-11-10";
const TEKST = "Eerste alinea met genoeg woorden.\nTweede alinea met ook genoeg woorden.";

const regel = (k, datum, extra = {}) => ({ k, url: k.slice(2), bron: "DeOrkaan", versie: 1, methode: "artikel", kop: "Kop", datum, tekst: TEKST, ...extra });

test("elke tekst komt in het bestand van zijn publicatiedag, schoon en met alinea's", async () => {
  const map = tmp();
  const log = maakLog();
  const s = await arch.voegToe(map, [
    regel("n:https://a/1", "2026-11-09T10:00:00Z"),
    regel("n:https://a/2", "2026-11-08T22:30:00Z"), // 23:30 Nederlandse tijd op 8 nov... 
    regel("n:https://a/3", "2026-11-09T23:30:00Z"), // 00:30 op 10 nov in Nederland
  ], { vandaag: VANDAAG, log });
  assert.equal(s.geschreven, 3);
  assert.deepEqual(fs.readdirSync(map).sort(), ["2026-11-08.json", "2026-11-09.json", "2026-11-10.json"]);
  const dag = arch.leesDag(map, "2026-11-09");
  const d = await dag;
  assert.equal(d.items["n:https://a/1"].tekst, "Eerste alinea met genoeg woorden.\n\nTweede alinea met ook genoeg woorden.");
  assert.equal(d.items["n:https://a/1"].alineas, 2);
  assert.equal(log.samenvatting().onderdelen.tekst.tellers.geschreven, 3);
  assert.equal(log.samenvatting().onderdelen.tekst.voorbeelden.length, 1); // één per bron
});

test("een tekst ouder dan de bewaartermijn wordt niet meer opgeslagen", async () => {
  const map = tmp();
  const s = await arch.voegToe(map, [regel("n:https://a/oud", "2026-10-20T10:00:00Z")], { vandaag: VANDAAG, log: maakLog() });
  assert.equal(s.teOud, 1);
  assert.deepEqual(fs.readdirSync(map), []);
});

test("een oudere versie overschrijft een nieuwere niet, een nieuwere wel", async () => {
  const map = tmp();
  const o = { vandaag: VANDAAG, log: maakLog() };
  await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z", { versie: 2, tekst: "Nieuwe versie met genoeg woorden." })], o);
  await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z", { versie: 1, tekst: "Oude versie met genoeg woorden." })], o);
  assert.match((await arch.leesDag(map, "2026-11-09")).items["n:https://a/1"].tekst, /Nieuwe/);
  await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z", { versie: 3, tekst: "Derde versie met genoeg woorden." })], o);
  assert.match((await arch.leesDag(map, "2026-11-09")).items["n:https://a/1"].tekst, /Derde/);
});

test("zonder wijziging wordt er niets herschreven", async () => {
  const map = tmp();
  const o = { vandaag: VANDAAG, log: maakLog() };
  await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z")], o);
  const voor = fs.statSync(path.join(map, "2026-11-09.json")).mtimeMs;
  await new Promise((r) => setTimeout(r, 15));
  const s = await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z")], o);
  assert.equal(s.dagbestanden, 0);
  assert.equal(fs.statSync(path.join(map, "2026-11-09.json")).mtimeMs, voor);
});

test("opruimen verwijdert alleen dagbestanden ouder dan de bewaartermijn", async () => {
  const map = tmp();
  for (const d of ["2026-10-20", "2026-10-26", "2026-10-27", "2026-11-10"]) fs.writeFileSync(path.join(map, `${d}.json`), JSON.stringify({ dag: d, items: {} }));
  fs.writeFileSync(path.join(map, "leesmij.txt"), "blijft");
  const r = await arch.ruimOp(map, VANDAAG, 14, maakLog());
  assert.equal(r.verwijderd, 2); // grens is 2026-10-27
  assert.deepEqual(fs.readdirSync(map).sort(), ["2026-10-27.json", "2026-11-10.json", "leesmij.txt"]);
});

test("de oude jsonl-bestanden worden overgezet en verwijderd", async () => {
  const oud = tmp();
  const nieuw = tmp();
  const lijn = (k, datum) => JSON.stringify({ k, url: k.slice(2), bron: "DeOrkaan", versie: 1, methode: "artikel", kop: "Kop", datum, tekst: TEKST });
  fs.writeFileSync(
    path.join(oud, "teksten-2026-11-05.jsonl"),
    [lijn("n:https://a/1", "2026-11-04T10:00:00Z"), "kapotte regel", lijn("n:https://a/2", "2026-10-01T10:00:00Z")].join("\n") + "\n"
  );
  fs.writeFileSync(path.join(oud, "geheugen.json"), "{}");
  const r = await arch.migreerOudeBestanden(oud, nieuw, { vandaag: VANDAAG, log: maakLog() });
  assert.equal(r.bestanden, 1);
  assert.deepEqual(fs.readdirSync(oud), ["geheugen.json"]); // jsonl weg, rest blijft
  assert.deepEqual(fs.readdirSync(nieuw), ["2026-11-04.json"]); // de tekst van 1 oktober is te oud
});

test("dekking: per bron hoeveel berichten een tekst hebben", async () => {
  const map = tmp();
  const log = maakLog();
  await arch.voegToe(map, [regel("n:https://a/1", "2026-11-09T10:00:00Z")], { vandaag: VANDAAG, log });
  const records = [
    { id: "x1-v1", groepId: "x1", versie: 1, url: "https://a/1", bronId: "DeOrkaan", tijd: "2026-11-09T10:00:00Z" },
    { id: "x2-v1", groepId: "x2", versie: 1, url: "https://a/2", bronId: "DeOrkaan", tijd: "2026-11-09T11:00:00Z" },
    { id: "x3-v1", groepId: "x3", versie: 1, url: "https://b/1", bronId: "ibabs", tijd: "2026-11-09T11:00:00Z" },
    { id: "x4-v1", groepId: "x4", versie: 1, url: "https://b/oud", bronId: "ibabs", tijd: "2026-09-01T11:00:00Z" }, // te oud: telt niet mee
  ];
  const d = await arch.dekking(map, records, { vandaag: VANDAAG, log });
  assert.equal(d.berichten, 3);
  assert.equal(d.metTekst, 1);
  assert.equal(d.pct, 33);
  assert.equal(d.perBron.DeOrkaan.pct, 50);
  assert.equal(d.perBron.ibabs.metTekst, 0);
});
