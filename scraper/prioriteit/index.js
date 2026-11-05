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
//     stukken erover zoeken, impact meten, de score berekenen (score.js).
//  3. De drempel tau bepalen en beslissen (beslis.js).
//  4. In modus "aan": het veld `rood` op de items zetten. In modus "schaduw"
//     alleen rekenen en loggen.
//
// Raakt `prio` van berichten niet aan. De frontend vertaalt `rood` naar kleur.
// Een fout in deze functie mag de ZANP-run nooit stoppen: zanp.js vangt hem op.

"use strict";

const { kalenderdagAmsterdam } = require("../hulpmiddelen");
const { leesInstellingen } = require("./instellingen");
const { analyseer } = require("./taal");
const { maakVingerafdruk, analyseUitVingerafdruk, bouwContext, bouwZoekvraag, zoekEvidentie } = require("./analyse");
const { berekenImpact, berekenScore, bepaalTau } = require("./score");
const { beslis } = require("./beslis");
const { maakWerklijst, haalTeksten, agendaKomt, laatstePerGroep } = require("./tekst");
const { mapVan, leesGeheugen, schrijfGeheugen, ruimOp, schrijfSchaduwlog, voegTekstenToe } = require("./geheugen");

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

function maakReden(k, s, evidentie, F) {
  const meetellend = evidentie.filter((e) => e.c >= F.minCentraliteit);
  const bronnen = [...new Set(meetellend.map((e) => e.bron))].slice(0, 3).join(", ");
  return (
    `${s.n} stuk(ken) over ${k.ankers.slice(0, 3).join(", ")} in ${s.dagen} dag(en) uit ${s.bronnen} bron(nen)` +
    `${bronnen ? ` (${bronnen})` : ""}; ${s.route === "piek" ? "piek in de laatste 48 uur" : "aanhoudend"}; ` +
    `impact ${s.K.toFixed(2)}; score ${s.S.toFixed(2)}`
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
    nietOphalen = () => false,
    aiVeto = null,
    log = console,
  } = opties;

  const inst = leesInstellingen(env);
  const F = inst.formule;
  const stats = { modus: inst.modus };
  if (inst.modus === "uit") return { records, agendaItems, stats };

  const map = mapVan(env);
  const { geheugen, voor } = await leesGeheugen(map);
  const vandaag = kalenderdagAmsterdam(nu.toISOString());

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
  const vingerafdrukken = Object.values(geheugen.docs);
  stats.stukken = vingerafdrukken.length;

  // 2. Kandidaten: wat kan rood worden?
  const kandidaten = [];
  const nieuwsGrens = nu.getTime() - F.nieuwsVersUren * 3600 * 1000;
  for (const i of agendaItems) {
    if (!agendaKomt(i, vandaag, F)) continue;
    kandidaten.push({
      key: `a:${i.id}`,
      soort: "agenda",
      kop: i.kop || "",
      url: i.url,
      tot: i.eindDag,
      groepen: eigenGroepen(i),
    });
  }
  for (const r of laatstePerGroep(records)) {
    if (!r.url || r.seed) continue;
    const eerst = Date.parse(r.eerstGezienOp);
    if (!Number.isFinite(eerst) || eerst < nieuwsGrens) continue;
    kandidaten.push({
      key: `n:${r.url}`,
      soort: "nieuws",
      kop: r.bronTitel || r.kop || "",
      url: r.url,
      tot: null,
      groepen: new Set([r.groepId || r.id]),
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
    const uitsluiten = (ander) => ander.k === k.key || ander.url === k.url || (ander.groep && k.groepen.has(ander.groep));
    const evidentie = zoekEvidentie(vraag, vingerafdrukken, uitsluiten, F);
    const K = berekenImpact(a.impact, evidentie, nu, F);
    const score = berekenScore(evidentie, K, nu, F);
    k.ankers = vraag.ankers;
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
  const besluit = await beslis({ kandidaten: gescoord, tau, geheugen, nu, F, aiVeto, log });
  stats.kandidaten = kandidaten.length;
  stats.metAnker = gescoord.length;
  stats.zonderAnker = zonderAnker;
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
      n: k.score.n,
      dagen: k.score.dagen,
      bronnen: k.score.bronnen,
      ankers: k.ankers,
      bewijs: k.bewijs,
    }));
  try {
    await schrijfGeheugen(map, geheugen, voor, nu);
    await schrijfSchaduwlog(map, { gegenereerdOp: nu.toISOString(), modus: inst.modus, tau: stats.tau, stats, top }, vandaag, top, F);
  } catch (fout) {
    log.error(`[prioriteit] Opslaan mislukte: ${fout.stack || fout.message}`);
  }

  // 6. Kleuren, alleen in modus "aan"
  if (inst.modus !== "aan") return { records, agendaItems, stats };
  const nieuweRecords = records.map((r) => {
    const e = geheugen.rood[`n:${r.url}`];
    return e ? { ...r, rood: openbaar(e) } : r;
  });
  const nieuweAgenda = agendaItems.map((i) => {
    const e = geheugen.rood[`a:${i.id}`];
    return e ? { ...i, rood: openbaar(e) } : i;
  });
  return { records: nieuweRecords, agendaItems: nieuweAgenda, stats };
}

module.exports = { draaiPrioriteit, leesInstellingen };
