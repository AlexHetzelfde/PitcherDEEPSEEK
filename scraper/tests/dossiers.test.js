const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../dossiers");
const spelling = require("../spelling");
const runlog = require("../runlog");

const stil = { log() {}, error() {} };
const maakLog = () => runlog.maakRunLog({ konsole: stil });
const NU = new Date("2026-11-12T10:00:00Z");
const dagen = (n) => new Date(NU.getTime() - n * 24 * 3600 * 1000).toISOString();

test.beforeEach(() => spelling.zetWoordenboek(null));
test.after(() => spelling.zetWoordenboek(null));

let teller = 0;
const bericht = (kop, dagGeleden, extra = {}) => {
  teller++;
  return {
    id: `g${teller}-v1`, groepId: `g${teller}`, versie: 1, url: `https://voorbeeld.nl/${teller}`, kop,
    bronId: "DeOrkaan", bronNaam: "De Orkaan", tijd: dagen(dagGeleden), rubriek: "VER", ...extra,
  };
};
// vijf verschillende verhalen over de busbrug, over vijf dagen
const busbrugVijf = () => [
  bericht("Busbrug in Zaandam blijft dicht na nieuwe schade", 6),
  bericht("Raad wil antwoorden over vertraging van de busbrug", 5, { bronId: "zaanstad-persberichten", bronNaam: "Zaanstad" }),
  bericht("Fietsers boos over omleiding rond de busbrug", 4),
  bericht("Aannemer verwacht busbrug pas in het voorjaar open", 3),
  bericht("Provincie schiet te hulp bij kosten van de busbrug", 2, { bronId: "nh-actueel", bronNaam: "Provincie" }),
];

test("de stam haalt meervoud en verbuiging eraf", () => {
  assert.equal(d.stam("planten"), "plant");
  assert.equal(d.stam("bruggen"), "brug".length >= 5 ? "brug" : "bruggen"); // te kort: blijft zoals het is
  assert.equal(d.stam("busbruggen"), "busbrug");
  assert.equal(d.stam("busbrug"), "busbrug");
  assert.ok(d.stammen("De Zaanse planten worden gered").has("plant"));
  assert.ok(!d.stammen("Het is vandaag in november").has("november")); // stopwoord
});

test("updateStubs: routinebronnen eruit, nieuwste versie, oude stubs verlopen", () => {
  const records = [
    bericht("Een gewoon bericht over iets bijzonders", 1),
    bericht("Omgevingsvergunning aangevraagd voor een schuur", 1, { bronId: "bekendmakingen" }),
    { ...bericht("Oude versie van een kop in de lijst", 2, { groepId: "dubbel", id: "dubbel-v1" }) },
    { ...bericht("Nieuwe versie van een kop in de lijst", 1, { groepId: "dubbel", id: "dubbel-v2", versie: 2 }) },
  ];
  const oud = { weg: { g: "weg", u: "https://x/oud", k: "Heel oud", b: "DeOrkaan", n: "", t: dagen(61), c: null, r: null } };
  const r = d.updateStubs(oud, records, NU);
  assert.equal(Object.keys(r.items).length, 2); // gewoon bericht + de nieuwste versie
  assert.ok(r.items.dubbel.k.startsWith("Nieuwe versie"));
  assert.equal(r.verlopen, 1);
  assert.equal(r.nieuw, 2);
  assert.ok(!Object.values(r.items).some((s) => s.b === "bekendmakingen"));
});

test("verhaalSleutels: een briefactie bij dezelfde bron telt als één verhaal, een cluster ook", () => {
  const brief = (nr, kop) => bericht(kop, 1, { bronId: "ibabs-ingekomen-stukken", bronTitel: `Mail Brief aan de gemeenteraad - planten redden bij sloop in Zaanstad ${nr % 2 ? "" : ""}`.trim() });
  const records = [
    brief(1, "Inwoner stuurt brief over redden van planten bij sloop"),
    brief(2, "Inwoner vraagt gemeenteraad om aandacht voor circulair groenbeheer"),
    brief(3, "Inwoner stuurt voorstel naar gemeenteraad voor hergebruik van planten"),
    bericht("Zaanse molen draait weer na restauratie van de wieken", 2, { clusterId: "abc" }),
    bericht("Molen draait weer: restauratie van de wieken is klaar", 2, { clusterId: "abc", bronId: "nh-actueel" }),
    bericht("Heel ander verhaal over iets totaal anders vandaag", 1),
  ];
  const stubs = d.updateStubs({}, records, NU).items;
  const sl = d.verhaalSleutels(stubs);
  assert.equal(new Set(sl.values()).size, 3); // brieven, molen-cluster, ander verhaal
});

test("zoekKandidaten: vijf unieke verhalen over meerdere dagen geven een kandidaat", () => {
  const stubs = d.updateStubs({}, busbrugVijf(), NU).items;
  const z = d.zoekKandidaten({ stubs, sleutels: d.verhaalSleutels(stubs), dossiers: [] });
  assert.equal(z.kandidaten.length, 1);
  assert.equal(z.kandidaten[0].vorm, "busbrug");
  assert.equal(z.kandidaten[0].aantal, 5);
});

test("zoekKandidaten: vier verhalen, of vijf op één dag, of een briefactie geven geen kandidaat", () => {
  const vier = busbrugVijf().slice(0, 4);
  let stubs = d.updateStubs({}, vier, NU).items;
  assert.equal(d.zoekKandidaten({ stubs, sleutels: d.verhaalSleutels(stubs), dossiers: [] }).kandidaten.length, 0);

  const eenDag = busbrugVijf().map((r) => ({ ...r, tijd: dagen(1) }));
  stubs = d.updateStubs({}, eenDag, NU).items;
  assert.equal(d.zoekKandidaten({ stubs, sleutels: d.verhaalSleutels(stubs), dossiers: [] }).kandidaten.length, 0);

  const brieven = Array.from({ length: 5 }, (_, i) =>
    bericht(`Inwoner ${["stuurt", "vraagt", "schrijft", "mailt", "dient"][i]} brief over groenbeheer bij sloop`, 5 - i, {
      bronId: "ibabs-ingekomen-stukken", bronTitel: "Mail Brief aan de gemeenteraad - groenbeheer bij sloop in Zaanstad",
    })
  );
  stubs = d.updateStubs({}, brieven, NU).items;
  assert.equal(d.zoekKandidaten({ stubs, sleutels: d.verhaalSleutels(stubs), dossiers: [] }).kandidaten.length, 0); // 1 verhaal
});

test("zoekKandidaten: een onderwerp dat al een dossier heeft, of net is afgewezen, komt niet terug", () => {
  const stubs = d.updateStubs({}, busbrugVijf(), NU).items;
  const sl = d.verhaalSleutels(stubs);
  const dossier = { naam: "Busbrug", zoektermen: ["busbrug"], items: [], uitgesloten: [] };
  assert.equal(d.zoekKandidaten({ stubs, sleutels: sl, dossiers: [dossier] }).kandidaten.length, 0);
  assert.equal(d.zoekKandidaten({ stubs, sleutels: sl, dossiers: [], afgewezen: { busbrug: { aantal: 5, tijd: NU.toISOString() } } }).kandidaten.length, 0);
  assert.equal(d.zoekKandidaten({ stubs, sleutels: sl, dossiers: [], afgewezen: { busbrug: { aantal: 2, tijd: NU.toISOString() } } }).kandidaten.length, 1); // inmiddels +3 en 2,5 keer zoveel
  assert.equal(d.zoekKandidaten({ stubs, sleutels: sl, dossiers: [], afgewezen: { busbrug: { aantal: 4, tijd: NU.toISOString() } } }).kandidaten.length, 0); // pas bij 6 (anderhalf keer 4)
});

test("valideerDossierAntwoord", () => {
  const stubs = d.updateStubs({}, busbrugVijf(), NU).items;
  const kandidaat = d.zoekKandidaten({ stubs, sleutels: d.verhaalSleutels(stubs), dossiers: [] }).kandidaten[0];
  const tags = [{ code: "VER", naam: "Verkeer" }, { code: "GEM", naam: "Gemeente" }];
  const goed = d.valideerDossierAntwoord({ dossier: true, naam: "Busbrug Zaandam", tag: "VER", zoektermen: ["busbrug", "omleiding"], horenErbij: [1, 2, 3, 4, 5] }, kandidaat, tags);
  assert.equal(goed.dossier, true);
  assert.equal(goed.tag, "VER");
  assert.deepEqual(goed.zoektermen, ["busbrug"]); // "omleiding" staat maar in één kop: niet bevestigd
  assert.equal(goed.leden.length, 5);

  assert.deepEqual(d.valideerDossierAntwoord({ dossier: false }, kandidaat, tags), { dossier: false, reden: "ai-nee" });
  assert.equal(d.valideerDossierAntwoord({ dossier: true, naam: "Busbrug", tag: "VER", zoektermen: ["busbrug"], horenErbij: [1, 2, 3] }, kandidaat, tags).reden, "te-weinig-bij-elkaar");
  assert.equal(d.valideerDossierAntwoord({ dossier: true, naam: "", horenErbij: [1, 2, 3, 4, 5] }, kandidaat, tags), null);
  assert.equal(d.valideerDossierAntwoord("onzin", kandidaat, tags), null);
  // onbekende tag: de meerderheid van de rubrieken van de berichten
  assert.equal(d.valideerDossierAntwoord({ dossier: true, naam: "Busbrug", tag: "XXX", zoektermen: [], horenErbij: [1, 2, 3, 4, 5] }, kandidaat, tags).tag, "VER");
});

test("een volledige run: de AI maakt een dossier, daarna koppelt alleen het script", async () => {
  const log = maakLog();
  const tags = [{ code: "VER", naam: "Verkeer" }];
  const vragen = [];
  const vraagAI = async (prompt) => {
    vragen.push(prompt);
    return { data: { dossier: true, naam: "Busbrug Zaandam", tag: "VER", zoektermen: ["busbrug"], horenErbij: [1, 2, 3, 4, 5] }, verzoeken: 1 };
  };
  const records = busbrugVijf();
  const eerste = await d.draaiDossiers({ records, nu: NU, modus: "log", stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI, tags, log });
  assert.equal(vragen.length, 1);
  assert.ok(vragen[0].includes('"busbrug"'));
  assert.equal(eerste.stats.nieuweDossiers, 1);
  const dossier = eerste.dossiersBestand.dossiers[0];
  assert.equal(dossier.naam, "Busbrug Zaandam");
  assert.equal(dossier.items.length, 5);
  assert.equal(eerste.dossiersBestand.modus, "log");
  assert.ok(dossier.items[0].u && dossier.items[0].k && dossier.items[0].t); // kop, link en datum blijven

  // een nieuw bericht over de busbrug: geen AI-aanroep, wel gekoppeld
  vragen.length = 0;
  const nieuw = bericht("Busbrug eindelijk weer open voor het verkeer", 0);
  const tweede = await d.draaiDossiers({
    records: [...records, nieuw], nu: NU, modus: "aan", stubsBestand: eerste.stubsBestand, dossiersBestand: eerste.dossiersBestand, vraagAI, tags, log,
  });
  assert.equal(vragen.length, 0);
  assert.equal(tweede.dossiersBestand.dossiers[0].items.length, 6);
  assert.equal(tweede.dossiersBestand.modus, "aan");

  // de log laat zien wat er gebeurde
  const s = log.samenvatting().onderdelen.dossiers;
  assert.equal(s.tellers.nieuweDossiers, 1);
  assert.equal(s.voorbeelden[0].besluit, "nieuw dossier");

  // na de bewaartijd van berichten.json blijven kop en link in het dossier staan
  const veel = new Date(NU.getTime() + 20 * 24 * 3600 * 1000);
  const later = await d.draaiDossiers({ records: [], nu: veel, modus: "aan", stubsBestand: tweede.stubsBestand, dossiersBestand: tweede.dossiersBestand, vraagAI: null, tags, log });
  assert.equal(later.dossiersBestand.dossiers[0].items.length, 6);
});

test("een afwijzing van de AI wordt onthouden: dezelfde kandidaat wordt niet opnieuw gevraagd", async () => {
  let n = 0;
  const vraagAI = async () => {
    n++;
    return { data: { dossier: false }, verzoeken: 1 };
  };
  const records = busbrugVijf();
  const a = await d.draaiDossiers({ records, nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI, tags: [], log: maakLog() });
  assert.equal(n, 1);
  assert.equal(a.stats.aiNee, 1);
  assert.equal(a.dossiersBestand.dossiers.length, 0);
  await d.draaiDossiers({ records, nu: NU, stubsBestand: a.stubsBestand, dossiersBestand: a.dossiersBestand, vraagAI, tags: [], log: maakLog() });
  assert.equal(n, 1);
});

test("een AI-fout of onbruikbaar antwoord onthoudt niets en een 429 stopt de rest", async () => {
  const records = busbrugVijf();
  let aanroepen = 0;
  const kapot = async () => {
    aanroepen++;
    const f = new Error("quotum");
    f.status = 429;
    throw f;
  };
  const r = await d.draaiDossiers({ records, nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI: kapot, tags: [], log: maakLog() });
  assert.equal(r.quotum, true);
  assert.equal(r.stats.aiFout, 1);
  assert.deepEqual(r.dossiersBestand.afgewezen, {});

  const onzin = await d.draaiDossiers({ records, nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI: async () => ({ data: "geen json", verzoeken: 1 }), tags: [], log: maakLog() });
  assert.equal(onzin.stats.aiFout, 1);
  assert.deepEqual(onzin.dossiersBestand.afgewezen, {});
});

test("zonder AI worden stubs wel bijgehouden en bestaande dossiers wel aangevuld", async () => {
  const r = await d.draaiDossiers({ records: busbrugVijf(), nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI: null, tags: [], maxControles: 0, log: maakLog() });
  assert.equal(Object.keys(r.stubsBestand.items).length, 5);
  assert.equal(r.stats.aiControles, 0);
});

test("een dossier zonder nieuw bericht vervalt na 90 dagen", async () => {
  const oud = { id: "d1", naam: "Oud", tag: "ALG", zoektermen: ["oudwoord"], aangemaaktOp: dagen(200), laatsteBericht: dagen(91), uitgesloten: [], items: [{ u: "https://x/1", k: "Oud bericht", n: "", b: "", t: dagen(91) }] };
  const vers = { ...oud, id: "d2", naam: "Vers", laatsteBericht: dagen(10), items: [{ u: "https://x/2", k: "Vers bericht", n: "", b: "", t: dagen(10) }] };
  const log = maakLog();
  const r = await d.draaiDossiers({ records: [], nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [oud, vers], afgewezen: {} }, vraagAI: null, tags: [], log });
  assert.deepEqual(r.dossiersBestand.dossiers.map((x) => x.naam), ["Vers"]);
  assert.equal(r.stats.dossiersVerlopen, 1);
});

test("een bericht dat de AI uit het dossier hield, komt er ook later niet automatisch in", async () => {
  const records = [...busbrugVijf(), bericht("Busbrug van speelgoed te koop op de rommelmarkt in Wormer", 3)];
  // een nep-AI die de genummerde koppen uit de prompt leest en het speelgoedbericht weglaat
  const vraagAI = async (prompt) => {
    const nummers = [...prompt.matchAll(/^(\d+)\. \[[^\]]*\] (.*)$/gm)].filter((m) => !m[2].includes("speelgoed")).map((m) => Number(m[1]));
    return { data: { dossier: true, naam: "Busbrug Zaandam", tag: "VER", zoektermen: ["busbrug"], horenErbij: nummers }, verzoeken: 1 };
  };
  const r = await d.draaiDossiers({ records, nu: NU, stubsBestand: { items: {} }, dossiersBestand: { dossiers: [], afgewezen: {} }, vraagAI, tags: [], log: maakLog() });
  const dossier = r.dossiersBestand.dossiers[0];
  assert.equal(dossier.items.length, 5);
  assert.ok(!dossier.items.some((i) => i.k.includes("speelgoed")));
  assert.equal(dossier.uitgesloten.length, 1);
  // een volgende run met dezelfde berichten voegt het speelgoedbericht niet toe
  const later = await d.draaiDossiers({ records, nu: NU, stubsBestand: r.stubsBestand, dossiersBestand: r.dossiersBestand, vraagAI: null, tags: [], log: maakLog() });
  assert.equal(later.dossiersBestand.dossiers[0].items.length, 5);
});
