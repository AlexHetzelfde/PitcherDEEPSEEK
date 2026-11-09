// Tests voor cameratoezicht: reeksen, rode regel, agenda en de scraper zelf
// (met een nagemaakte feed en nagemaakte besluitpagina's, zonder netwerk).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const R = require("../camera-reeks");
const wire = require("../wire");
const { cameraRood } = require("../prioriteit/regels");

const b = (url, titel, camera, plaats, start, eind) => ({ url, titel, camera, plaats, start, eind, pubdate: start });

const ELZEN = [
  b("u1", "Aanwijzingsbesluit tijdelijk cameratoezicht Elzenstraat", "Elzenstraat", null, "2026-07-16", "2026-08-26"),
  b("u2", "Aanwijzingsbesluit extra tijdelijk cameratoezicht Elzenstraat in Wormerveer", "Elzenstraat in Wormerveer", "Wormerveer", "2026-07-27", "2026-08-31"),
  b("u3", "Aanwijzingsbesluit verlenging tijdelijk cameratoezicht Elzenstraat in Wormerveer", "Elzenstraat in Wormerveer", "Wormerveer", "2026-08-27", "2026-10-01"),
  b("u4", "Aanwijzingsbesluit verlenging tijdelijk cameratoezicht Elzenstraat in Wormerveer", "Elzenstraat in Wormerveer", "Wormerveer", "2026-10-01", "2026-11-01"),
  b("u5", "Aanwijzingsbesluit verlenging tijdelijk cameratoezicht Elzenstraat in Wormerveer", "Elzenstraat in Wormerveer", "Wormerveer", "2026-11-01", "2026-12-01"),
];

test("een verlenging na afloop begint geen nieuwe reeks (de fout uit IbabsLos2)", () => {
  const rode = [
    b("a", "Aanwijzingsbesluit tijdelijk cameratoezicht Rode Zee te Zaandam", "Rode Zee te Zaandam", "Zaandam", "2026-09-08", "2026-10-18"),
    b("b", "Aanwijzingsbesluit verlenging tijdelijk cameratoezicht Rode Zee in Zaandam", "Rode Zee te Zaandam", "Zaandam", "2026-10-18", "2026-11-15"),
  ];
  const reeksen = R.bouwReeksen(rode);
  assert.equal(reeksen.length, 1);
  assert.equal(reeksen[0].aantal, 2);
  assert.deepEqual(reeksen[0].besluiten.map((x) => x.nr), [1, 2]);
});

test("'Elzenstraat' en 'Elzenstraat in Wormerveer' zijn één reeks van vijf besluiten", () => {
  const reeksen = R.bouwReeksen(ELZEN);
  assert.equal(reeksen.length, 1);
  assert.equal(reeksen[0].aantal, 5);
  assert.equal(reeksen[0].plaats, "Wormerveer");
  assert.equal(reeksen[0].eind, "2026-12-01");
});

test("zelfde straat in een andere plaats is een andere plek", () => {
  const reeksen = R.bouwReeksen([
    b("a", "t", "Kerkstraat te Zaandam", "Zaandam", "2026-09-01", "2026-10-01"),
    b("b", "t", "Kerkstraat te Krommenie", "Krommenie", "2026-09-05", "2026-10-05"),
  ]);
  assert.equal(reeksen.length, 2);
});

test("na een lange pauze is het weer een eerste aanwijzing", () => {
  const reeksen = R.bouwReeksen([
    b("a", "Aanwijzingsbesluit tijdelijk cameratoezicht Zuiddijk", "Zuiddijk", null, "2026-07-01", "2026-08-01"),
    b("b", "Aanwijzingsbesluit tijdelijk cameratoezicht Zuiddijk", "Zuiddijk", null, "2026-11-01", "2026-12-01"),
  ]);
  assert.equal(reeksen.length, 2);
});

test("een deel van een straatnaam telt niet als dezelfde plek", () => {
  assert.equal(R.sleutelsPassen("kerk", "kerkstraat"), false);
  assert.equal(R.sleutelsPassen("perim", "perim ingang een"), true);
});

test("rood: de eerste aanwijzing en het 5e besluit, de rest niet", () => {
  const [reeks] = R.bouwReeksen(ELZEN);
  const rood = reeks.besluiten.map((x) => Boolean(R.roodReden(reeks, x)));
  assert.deepEqual(rood, [true, false, false, false, true]);
});

test("een reeks die met een verlenging begint heeft geen 'eerste aanwijzing'", () => {
  const [reeks] = R.bouwReeksen([b("a", "Aanwijzingsbesluit verlenging tijdelijk cameratoezicht X-plein", "X-plein", null, "2026-09-01", "2026-10-01")]);
  assert.equal(R.roodReden(reeks, reeks.besluiten[0]), null);
});

test("de agenda krijgt de dag na het einde en schuift mee bij verlenging", () => {
  const nu = new Date("2026-11-20T10:00:00Z");
  const voor = R.bouwReeksen(ELZEN.slice(0, 4));
  const na = R.bouwReeksen(ELZEN);
  const a1 = wire.agendaItemsUitCamera(voor, nu);
  const a2 = wire.agendaItemsUitCamera(na, nu);
  assert.equal(a1[0].startDag, "2026-11-02");
  assert.equal(a2[0].startDag, "2026-12-02");
  assert.notEqual(a1[0].id, a2[0].id);
  assert.equal(a2[0].afkomst, "camera");
});

test("bouwAgenda leidt camera-items elke run opnieuw af en bewaart oude niet", () => {
  // bouwAgenda gebruikt de echte datum van vandaag voor het venster; de reeks eindigt dus over 5 dagen.
  const nu = new Date();
  const dag = (plus) => new Date(nu.getTime() + plus * 86_400_000).toISOString().slice(0, 10);
  const reeksen = R.bouwReeksen([b("a", "Aanwijzingsbesluit tijdelijk cameratoezicht Zuiddijk te Zaandam", "Zuiddijk te Zaandam", "Zaandam", dag(-30), dag(5))]);
  const eerste = wire.bouwAgenda({ ruweBerichten: [], bronPerId: {}, bestaand: [], berichtRecords: [], cameraReeksen: reeksen, nu });
  const camera = eerste.items.filter((i) => i.afkomst === "camera");
  assert.equal(camera.length, 1);
  assert.equal(camera[0].startDag, dag(6));
  const tweede = wire.bouwAgenda({ ruweBerichten: [], bronPerId: {}, bestaand: eerste.items, berichtRecords: [], cameraReeksen: [], nu });
  assert.equal(tweede.items.filter((i) => i.afkomst === "camera").length, 0);
});

test("cameraRood kleurt alleen berichten met een rood besluit", () => {
  const reeksen = R.bouwReeksen(ELZEN);
  const records = ["u1", "u3", "u5"].map((url) => ({ url, kop: url, camera: {}, eerstGezienOp: "2026-11-01T00:00:00Z" }));
  const rood = cameraRood({ records, cameraReeksen: reeksen });
  assert.deepEqual([...rood.keys()].sort(), ["n:u1", "n:u5"]);
  assert.equal(rood.get("n:u5").route, "regel");
});

// ---- de scraper zelf, met nagemaakte feed en pagina's --------------------------

const feed = `<?xml version="1.0"?><rss><channel>
<item><title>gmb-1 : Zaanstad</title><description>Aanwijzingsbesluit tijdelijk cameratoezicht Schoenerstraat in Zaandam</description><link>https://x.nl/gmb-1.html</link><pubDate>%DAG%</pubDate></item>
<item><title>gmb-2 : Zaanstad</title><description>Iets over camerabeveiliging</description><link>https://x.nl/gmb-2.html</link><pubDate>%DAG%</pubDate></item>
</channel></rss>`;

const pagina = `<html><head>
<meta name="DC.title" content="Aanwijzingsbesluit tijdelijk cameratoezicht Schoenerstraat in Zaandam"/>
<meta name="OVERHEIDop.startdatum" content="2026-11-05"/><meta name="OVERHEIDop.einddatum" content="2026-12-10"/></head>
<body><p>Camera: Schoenerstraat te Zaandam</p>
<p>Overwegende dat er herhaaldelijk overlast en een schietincident is geweest; gelet op artikel 151c.</p></body></html>`;

test("de scraper haalt een nieuw besluit op, bouwt de reeks en schrijft bestanden alleen bij verandering", async () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "zanp-camera-"));
  process.env.ZANP_DATA_DIR = map;
  delete require.cache[require.resolve("../scrapers/camera")];
  const { scrapeCamera } = require("../scrapers/camera");
  const vandaag = new Date().toISOString();
  const echteFetch = global.fetch;
  const aangeroepen = [];
  global.fetch = async (url) => {
    aangeroepen.push(url);
    const tekst = String(url).includes("rss") ? feed.replaceAll("%DAG%", vandaag) : pagina;
    return { ok: true, status: 200, text: async () => tekst };
  };
  try {
    const bron = { id: "zaanstad-camera", naam: "Camera", categorie: "lokaal", url: "https://zoek.example/rss" };
    const eerste = await scrapeCamera(bron);
    assert.equal(eerste.length, 1);
    assert.equal(eerste[0].camera.locatie, "Schoenerstraat");
    assert.equal(eerste[0].camera.plaats, "Zaandam");
    assert.equal(eerste[0].geenAi, true);
    assert.ok(eerste[0].camera.redenCategorieen.includes("Wapens/schietincident"));
    const reeksen = JSON.parse(fs.readFileSync(path.join(map, "zanp-camera", "reeksen.json"), "utf8")).reeksen;
    assert.equal(reeksen.length, 1);
    assert.equal(reeksen[0].besluiten[0].nr, 1);

    const paginaAanroepen = () => aangeroepen.filter((u) => String(u).includes("gmb-1")).length;
    assert.equal(paginaAanroepen(), 1);
    const tweede = await scrapeCamera(bron);
    assert.equal(paginaAanroepen(), 1, "een bekend besluit wordt niet opnieuw opgehaald");
    assert.equal(tweede.length, 1);
  } finally {
    global.fetch = echteFetch;
    delete process.env.ZANP_DATA_DIR;
  }
});
