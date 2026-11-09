// prioriteit/index.js
//
// De ene functie die zanp.js aanroept (ZANP 9): bepaalt welke agenda-items en
// nieuwsberichten "groot leven" en dus rood worden.
//
// Wat hij doet, in volgorde:
//  1. Volledige teksten ophalen van alle agenda-items en berichten (tekst.js)
//     en per stuk een vingerafdruk bewaren (analyse.js). De tekst zelf wordt
//     alleen in data/zanp-prioriteit/teksten-*.jsonl bewaard.
//  2. Voor elk item dat rood kan worden: zoekwoorden bepalen, de bewaarde
//     stukken erover zoeken, reeksen van dezelfde bron tot één stuk
//     samenvoegen, impact meten, de score berekenen (score.js). Geannuleerde
//     agenda-items doen niet mee en dubbele agenda-items tellen als één.
//  3. De drempel tau bepalen en beslissen (beslis.js): één rood per onderwerp
//     (bij agenda het eerstvolgende item), met als laatste stap een optionele
//     AI-controle die alleen kan tegenhouden (ai.js).
//
// Bij een nieuwe formule of de overgang naar modus "aan" wordt het rood-geheugen
// van de schaduwtijd gewist (stempel in instellingen.js); oude teksten worden
// na tekstBewaarDagen opgeruimd.
//  4. In modus "aan": het veld `rood` op de items zetten. In modus "schaduw"
//     alleen rekenen en loggen.
//
// Raakt `prio` van berichten niet aan. De frontend vertaalt `rood` naar kleur.
// Een fout in deze functie mag de ZANP-run nooit stoppen: zanp.js vangt hem op.

"use strict";

const { kalenderdagAmsterdam } = require("../hulpmiddelen");
const { leesInstellingen, formuleStempel } = require("./instellingen");
const { analyseer, schoon, AFGELAST } = require("./taal");
const {
  maakVingerafdruk,
  analyseUitVingerafdruk,
  bouwContext,
  bouwZoekvraag,
  zoekEvidentie,
  pasReeksregelToe,
} = require("./analyse");
const { berekenImpact, berekenScore, bepaalTau, PIEK_CATS } = require("./score");
const { maakAiVeto } = require("./ai");
const { beslis } = require("./beslis");
const { cameraRood } = require("./regels");
const { maakWerklijst, haalTeksten, agendaKomt, laatstePerGroep } = require("./tekst");
const {
  mapVan,
  leesGeheugen,
  schrijfGeheugen,
  ruimOp,
  ruimTekstenOp,
  schrijfSchaduwlog,
  voegTekstenToe,
} = require("./geheugen");

function afronden(x) {
  return Math.round(x * 100) / 100;
}

function groepVanBerichtId(id) {
  return String(id).replace(/-v\d+$/, "");
}

function eigenGroepen(item) {
  return new Set(
    [item.berichtId, ...(item.meerBerichten || []), item.uitkomstId].filter(Boolean).map(groepVanBerichtId)
  );
}

function openbaar(e) {
  return { sinds: e.sinds, score: e.score, route: e.route, reden: e.reden };
}

// Dezelfde kop op dezelfde startdag is hetzelfde agenda-item, ook als meer
// bronnen het melden.
function dubbelSleutel(i) {
  const kop = schoon(i.kop || "").replace(/[^a-z0-9]+/g, " ").trim();
  return `${kop}|${i.startDag || ""}`;
}

function maakReden(k, s, evidentie, F) {
  const meetellend = evidentie.filter((e) => e.c >= F.minCentraliteit);
  const bronnen = [...new Set(meetellend.map((e) => e.bron))].slice(0, 3).join(", ");
  return (
    `${s.n} stuk(ken) over ${k.ankers.slice(0, 3).join(", ")} in ${s.dagen} dag(en) uit ${s.bronnen} bron(nen)` +
    `${bronnen ? ` (${bronnen})` : ""}; ${s.route === "piek" ? "piek in de laatste 48 uur" : "aanhoudend"}; ` +
    `impact ${(s.route === "piek" ? s.Kp : s.K).toFixed(2)}; score ${s.S.toFixed(2)}`
  );
}

async function draaiPrioriteit(opties) {
  const {
    records,
    agendaItems,
    ruwe = [],
    nu = new Date(),
    env = process.env,
    bronPerId = {},
    cameraReeksen = [],
    nietOphalen = () => false,
    aiVeto = null,
    log = console,
  } = opties;

  const inst = leesInstellingen(env);
  const F = inst.formule;
  const stats = { modus: inst.modus, ai: Boolean(aiVeto) && inst.ai };
  if (inst.modus === "uit") return { records, agendaItems, stats };

  const map = mapVan(env);
  const { geheugen, voor } = await leesGeheugen(map);
  const vandaag = kalenderdagAmsterdam(nu.toISOString());

  // Rood uit de schaduwtijd is geen echt rood. Bij een nieuwe formule (zolang de
  // modus niet "aan" is) en bij de overgang naar "aan" begint het rood-geheugen
  // leeg; wat dan echt boven de drempel blijft, wordt binnen twee runs opnieuw
  // rood. In modus "aan" blijft rood staan, ook als de formule verandert.
  const stempel = formuleStempel();
  const formuleNieuw = geheugen.stempel !== stempel;
  const naarAan = inst.modus === "aan" && geheugen.modus !== "aan";
  if ((formuleNieuw && inst.modus !== "aan") || naarAan) {
    stats.roodGewist = Object.keys(geheugen.rood).length;
    geheugen.rood = {};
    geheugen.kandidaten = {};
    log.log(`[prioriteit] ${naarAan ? "Start van modus aan" : `Nieuwe formule ${stempel}`}: rood-geheugen leeggemaakt (${stats.roodGewist} item(s)).`);
  }
  geheugen.stempel = stempel;
  geheugen.modus = inst.modus;
  stats.formule = stempel;

  // 1. Teksten ophalen en vingerafdrukken maken
  try {
    const werklijst = maakWerklijst({ records, agendaItems, docs: geheugen.docs, vandaag, nu, F, inst });
    const ruweVanUrl = new Map();
    for (const b of ruwe) if (b && b.url && !ruweVanUrl.has(b.url)) ruweVanUrl.set(b.url, b);
    const ophaal = await haalTeksten(werklijst, {
      inst,
      ruweVanUrl,
      nietOphalen,
      detailSelectorVoor: (bronId) => (bronPerId[bronId] && bronPerId[bronId].detailSelector) || null,
      log,
    });
    const regels = [];
    for (const r of ophaal.resultaten) {
      const taak = r.taak;
      const a = analyseer({ kop: taak.kop, tekst: r.tekst });
      const pogingen = r.geenNieuwePoging ? inst.tekstMaxPogingen : taak.pogingen + (r.volledig ? 0 : 1);
      geheugen.docs[taak.key] = maakVingerafdruk(
        a,
        {
          key: taak.key,
          url: taak.url,
          bron: taak.bron,
          datum: taak.datum,
          groep: taak.groep,
          versie: taak.versie,
          soort: taak.soort,
          kop: taak.kop,
          volledig: r.volledig,
          pogingen,
          methode: r.methode,
        },
        F
      );
      if (r.tekst && r.methode !== "kort") {
        regels.push({
          k: taak.key,
          url: taak.url,
          bron: taak.bron,
          datum: taak.datum,
          versie: taak.versie,
          methode: r.methode,
          kop: taak.kop,
          tekst: r.tekst,
        });
      }
    }
    await voegTekstenToe(map, vandaag, regels);
    stats.tekst = ophaal.stats;
  } catch (fout) {
    log.error(`[prioriteit] Teksten ophalen mislukte (er wordt gerekend met wat al bewaard is): ${fout.stack || fout.message}`);
  }

  stats.vergeten = ruimOp(geheugen, nu, F);
  try {
    stats.tekstenOpgeruimd = await ruimTekstenOp(map, vandaag, F);
  } catch (fout) {
    log.error(`[prioriteit] Oude tekstbestanden opruimen mislukte: ${fout.message}`);
  }
  const vingerafdrukken = Object.values(geheugen.docs);
  stats.stukken = vingerafdrukken.length;

  // 2. Kandidaten: wat kan rood worden?
  const kandidaten = [];
  const nieuwsGrens = nu.getTime() - F.nieuwsVersUren * 3600 * 1000;
  // Agenda: geannuleerde items doen niet mee, dubbele items worden één kandidaat.
  const aliasVan = new Map(); // sleutel van een dubbel item -> sleutel van de kandidaat
  const dubbelGroepen = new Map();
  let afgelast = 0;
  for (const i of agendaItems) {
    if (!agendaKomt(i, vandaag, F)) continue;
    const sleutel = `a:${i.id}`;
    const fp = geheugen.docs[sleutel];
    if (i.status === "VERVALLEN" || AFGELAST.test(schoon(i.kop || "")) || (fp && fp.afgelast)) {
      afgelast++;
      continue;
    }
    const dk = dubbelSleutel(i);
    if (!dubbelGroepen.has(dk)) dubbelGroepen.set(dk, []);
    dubbelGroepen.get(dk).push({ i, sleutel, fp });
  }
  let dubbel = 0;
  for (const lijst of dubbelGroepen.values()) {
    // Voorkeur: het item dat al rood is, daarna het item met de meeste tekst.
    lijst.sort(
      (x, y) =>
        Number(Boolean(geheugen.rood[y.sleutel])) - Number(Boolean(geheugen.rood[x.sleutel])) ||
        ((y.fp && y.fp.woorden) || 0) - ((x.fp && x.fp.woorden) || 0)
    );
    const { i, sleutel, fp } = lijst[0];
    const gelijk = new Set(lijst.map((x) => x.sleutel));
    for (const x of lijst.slice(1)) {
      aliasVan.set(x.sleutel, sleutel);
      dubbel++;
    }
    kandidaten.push({
      key: sleutel,
      soort: "agenda",
      kop: i.kop || "",
      url: i.url,
      bron: i.bronId,
      start: i.startDag,
      tot: i.eindDag || i.startDag,
      groepen: eigenGroepen(i),
      gelijk,
    });
  }
  for (const r of laatstePerGroep(records)) {
    if (!r.url || r.seed) continue;
    if (r.camera) continue; // cameratoezicht: vaste regel (regels.js), niet de formule
    const eerst = Date.parse(r.eerstGezienOp);
    if (!Number.isFinite(eerst) || eerst < nieuwsGrens) continue;
    kandidaten.push({
      key: `n:${r.url}`,
      soort: "nieuws",
      kop: r.bronTitel || r.kop || "",
      url: r.url,
      bron: r.bronId,
      tot: null,
      groepen: new Set([r.groepId || r.id]),
      gelijk: new Set([`n:${r.url}`]),
    });
  }

  // 3. Scoren
  const agendaKoppen = agendaItems.filter((i) => i.afkomst === "bron").map((i) => i.kop || "");
  const ctx = bouwContext(vingerafdrukken, agendaKoppen, F);
  const gescoord = [];
  let zonderAnker = 0;
  for (const k of kandidaten) {
    const fp = geheugen.docs[k.key];
    const a = fp ? analyseUitVingerafdruk(fp) : analyseer({ kop: k.kop, tekst: "" });
    const vraag = bouwZoekvraag(a, ctx, F);
    if (!vraag.ankers.length) {
      zonderAnker++;
      continue;
    }
    const uitsluiten = (ander) =>
      k.gelijk.has(ander.k) || ander.url === k.url || (ander.groep && k.groepen.has(ander.groep));
    const ruw = zoekEvidentie(vraag, vingerafdrukken, uitsluiten, F);
    const evidentie = pasReeksregelToe(ruw, { bron: (fp && fp.bron) || k.bron, kop: a.kopStammen }, F);
    const K = berekenImpact(a.impact, evidentie, nu, F);
    const Kp = berekenImpact(a.impact, evidentie, nu, F, PIEK_CATS);
    const score = berekenScore(evidentie, K, nu, F, Kp);
    k.kern = (fp && fp.kern) || "";
    k.ankers = vraag.ankers;
    k.topAnkers = vraag.ankers.slice(0, 2);
    k.score = score;
    k.reden = maakReden(k, score, evidentie, F);
    k.bewijs = evidentie
      .filter((e) => e.c >= F.minCentraliteit)
      .sort((x, y) => y.c - x.c)
      .slice(0, 5)
      .map((e) => ({ bron: e.bron, datum: e.datum, c: afronden(e.c), plek: e.plek, titel: e.titel }));
    gescoord.push(k);
  }

  const tau = bepaalTau(gescoord.map((k) => k.score.S), F);

  // 4. Beslissen
  const besluit = await beslis({
    kandidaten: gescoord,
    tau,
    geheugen,
    nu,
    vandaag,
    F,
    aiVeto: inst.ai ? aiVeto : null,
    log,
  });
  stats.kandidaten = kandidaten.length;
  stats.metAnker = gescoord.length;
  stats.zonderAnker = zonderAnker;
  stats.afgelast = afgelast;
  stats.dubbel = dubbel;
  stats.tau = afronden(tau);
  stats.besluit = besluit.stats;
  stats.rood = Object.keys(geheugen.rood).length;
  for (const k of besluit.nieuwRood) {
    log.log(`  ROOD (${inst.modus}) ${k.soort}: ${k.kop.slice(0, 70)} — ${k.reden}`);
  }

  // 5. Opslaan
  const top = [...gescoord]
    .sort((x, y) => y.score.S - x.score.S)
    .slice(0, 40)
    .map((k) => ({
      key: k.key,
      soort: k.soort,
      kop: k.kop,
      S: afronden(k.score.S),
      Sa: afronden(k.score.Sa),
      Sp: afronden(k.score.Sp),
      route: k.score.route,
      K: afronden(k.score.K),
      Kp: afronden(k.score.Kp),
      n: k.score.n,
      dagen: k.score.dagen,
      bronnen: k.score.bronnen,
      ankers: k.ankers,
      bewijs: k.bewijs,
    }));
  try {
    await schrijfGeheugen(map, geheugen, voor, nu);
    await schrijfSchaduwlog(
      map,
      { gegenereerdOp: nu.toISOString(), modus: inst.modus, stempel, tau: stats.tau, stats, top },
      vandaag,
      top,
      F,
      formuleNieuw
    );
  } catch (fout) {
    log.error(`[prioriteit] Opslaan mislukte: ${fout.stack || fout.message}`);
  }

  // Rood op grond van een vaste regel (cameratoezicht): niet bewaard, elke run opnieuw bepaald.
  let regelRood = new Map();
  try {
    regelRood = cameraRood({ records, cameraReeksen });
    stats.regelRood = regelRood.size;
    for (const e of regelRood.values()) {
      if (e.sinds && nu.getTime() - Date.parse(e.sinds) <= 2 * 3600 * 1000) {
        log.log(`  ROOD-REGEL (${inst.modus}) nieuws: ${String(e.kop).slice(0, 70)} — ${e.reden}`);
      }
    }
  } catch (fout) {
    log.error(`[prioriteit] Rood op regel (camera) mislukte: ${fout.stack || fout.message}`);
  }

  // 6. Kleuren, alleen in modus "aan"
  if (inst.modus !== "aan") return { records, agendaItems, stats };
  const nieuweRecords = records.map((r) => {
    const e = geheugen.rood[`n:${r.url}`] || regelRood.get(`n:${r.url}`);
    return e ? { ...r, rood: openbaar(e) } : r;
  });
  const nieuweAgenda = agendaItems.map((i) => {
    const sleutel = `a:${i.id}`;
    const e = geheugen.rood[sleutel] || geheugen.rood[aliasVan.get(sleutel)];
    return e ? { ...i, rood: openbaar(e) } : i;
  });
  return { records: nieuweRecords, agendaItems: nieuweAgenda, stats };
}

module.exports = { draaiPrioriteit, leesInstellingen, maakAiVeto };
