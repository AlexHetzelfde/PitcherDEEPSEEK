const test = require("node:test");
const assert = require("node:assert/strict");
const runlog = require("../runlog");

const stil = { log() {}, error() {} };

test("buiten een run doet het logboek niets en geeft het geen fout", () => {
  runlog.stop();
  assert.equal(runlog.huidig().actief, false);
  runlog.huidig().tel("tekst", "x", 3);
  runlog.huidig().regel("tekst", "genegeerd");
  assert.deepEqual(runlog.huidig().samenvatting().onderdelen, {});
});

test("tellers tellen op, waarden en voorbeelden worden begrensd", () => {
  const l = runlog.maakRunLog({ konsole: stil });
  l.tel("tekst", "geschreven", 2);
  l.tel("tekst", "geschreven", 3);
  l.zet("tekst", "dekkingPct", 87);
  for (let i = 0; i < 20; i++) l.voorbeeld("tekst", { i }, 5);
  const s = l.samenvatting().onderdelen.tekst;
  assert.equal(s.tellers.geschreven, 5);
  assert.equal(s.waarden.dekkingPct, 87);
  assert.equal(s.voorbeelden.length, 5);
});

test("een regel gaat naar het Actions-log met het onderdeel ervoor", () => {
  const regels = [];
  const l = runlog.maakRunLog({ konsole: { log: (t) => regels.push(t), error() {} } });
  l.regel("tekst", "hallo");
  assert.deepEqual(regels, ["[log:tekst] hallo"]);
});

test("bewaar voegt de run toe, houdt details voor de laatste runs en telt per dag op", async () => {
  let opslag = null;
  const io = {
    leesJson: async () => opslag,
    schrijfJson: async (_naam, data) => {
      opslag = JSON.parse(JSON.stringify(data));
    },
  };
  for (let i = 0; i < runlog.DETAIL_RUNS + 5; i++) {
    const l = runlog.maakRunLog({ nu: new Date(`2026-11-10T${String(i % 24).padStart(2, "0")}:00:00Z`), konsole: stil });
    l.tel("tekst", "geschreven", 1);
    l.voorbeeld("tekst", { i });
    assert.equal(await l.bewaar(io), true);
  }
  assert.equal(opslag.runs.length, runlog.DETAIL_RUNS + 5);
  assert.equal(opslag.runs[0].onderdelen.tekst.voorbeelden, undefined); // oud: alleen tellers
  assert.equal(opslag.runs.at(-1).onderdelen.tekst.voorbeelden.length, 1); // nieuw: met voorbeeld
  assert.equal(opslag.dagen["2026-11-10"].tellers.tekst.geschreven, runlog.DETAIL_RUNS + 5);
});

test("een fout bij het opslaan stopt de run niet", async () => {
  const l = runlog.maakRunLog({ konsole: stil });
  const ok = await l.bewaar({
    leesJson: async () => null,
    schrijfJson: async () => {
      throw new Error("schijf vol");
    },
  });
  assert.equal(ok, false);
});
