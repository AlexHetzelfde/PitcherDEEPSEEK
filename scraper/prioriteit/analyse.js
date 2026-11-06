// prioriteit/analyse.js
//
// Van tekst naar vergelijkbare kernfeiten:
//   maakVingerafdruk   wat er per stuk bewaard wordt (NIET de tekst zelf)
//   bouwContext        zeldzaamheid van woorden over alle bewaarde stukken
//   bouwZoekvraag      de zoekwoorden van één item (agenda-item of bericht)
//   zoekEvidentie      welke bewaarde stukken gaan over dat item, en hoe centraal
//   pasReeksregelToe   stukken van dezelfde reeks (sjabloon) tellen niet als bewijs

"use strict";

const { stammen, deelTermen, ALGEMEEN, ORG_SEED, SOORT_SEED } = require("./taal");

/**
 * De vingerafdruk: genoeg om later opnieuw te kunnen rekenen, te klein om
 * een artikel uit te lezen.
 */
function maakVingerafdruk(a, meta, F) {
  const termen = {};
  const rijen = [...a.telling.entries()]
    .filter(([t, n]) => n >= 2 || a.namen.has(t) || t.includes("_"))
    .sort((x, y) => y[1] - x[1])
    .slice(0, F.termenPerDoc);
  for (const [t, n] of rijen) termen[t] = n;
  return {
    k: meta.key,
    url: meta.url,
    bron: meta.bron,
    datum: meta.datum,
    groep: meta.groep || null,
    versie: meta.versie || 1,
    soort: meta.soort,
    titel: String(meta.kop || "").slice(0, 140),
    woorden: a.woorden,
    kop: a.kopStammen,
    intro: a.introStammen,
    termen,
    namen: [...a.namen].slice(0, 40),
    impact: a.impact,
    bedrag: a.bedragMax || 0,
    getroffen: a.getroffenMax || 0,
    kern: a.kern || "",
    afgelast: Boolean(a.afgelast),
    volledig: Boolean(meta.volledig),
    pogingen: meta.pogingen || 0,
    methode: meta.methode || "",
  };
}

// Een vingerafdruk terug naar de vorm van analyseer(), om als zoekvraag te gebruiken.
function analyseUitVingerafdruk(fp) {
  return {
    woorden: fp.woorden,
    telling: new Map(Object.entries(fp.termen || {})),
    kopStammen: fp.kop || [],
    introStammen: fp.intro || [],
    namen: new Set(fp.namen || []),
    impact: fp.impact || {},
  };
}

const SETS = new WeakMap();
function setsVan(fp) {
  let s = SETS.get(fp);
  if (!s) {
    const kop = new Set(fp.kop || []);
    const intro = new Set(fp.intro || []);
    const alle = new Set([...Object.keys(fp.termen || {}), ...kop, ...intro]);
    s = { kop, intro, alle };
    SETS.set(fp, s);
  }
  return s;
}

/**
 * Zeldzaamheid van woorden (idf) over alle bewaarde stukken, plus twee lijsten
 * woorden die weinig zeggen: sjabloonwoorden van één bron en soortwoorden uit
 * agenda-koppen ("verkeersbesluit", "evenementenvergunning").
 */
function bouwContext(vingerafdrukken, agendaKoppen, F) {
  const N = Math.max(1, vingerafdrukken.length);
  const df = new Map();
  const bronDocs = new Map();
  const bronTerm = new Map();
  for (const fp of vingerafdrukken) {
    bronDocs.set(fp.bron, (bronDocs.get(fp.bron) || 0) + 1);
    for (const t of setsVan(fp).alle) {
      df.set(t, (df.get(t) || 0) + 1);
      let m = bronTerm.get(t);
      if (!m) {
        m = new Map();
        bronTerm.set(t, m);
      }
      m.set(fp.bron, (m.get(fp.bron) || 0) + 1);
    }
  }
  const template = new Set();
  for (const [t, m] of bronTerm) {
    for (const [bron, n] of m) {
      const docs = bronDocs.get(bron) || 0;
      if (docs >= F.templateMinDocs && n >= Math.max(F.templateMinTreffers, F.templateAandeel * docs)) {
        template.add(t);
        break;
      }
    }
  }
  const soort = new Set(SOORT_SEED);
  const tel = new Map();
  for (const kop of agendaKoppen) for (const t of new Set(stammen(kop))) tel.set(t, (tel.get(t) || 0) + 1);
  const grens = Math.max(F.soortMin, F.soortAandeel * agendaKoppen.length);
  for (const [t, n] of tel) if (n >= grens) soort.add(t);

  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  return { N, df, template, soort, org: ORG_SEED, idf };
}

// Een anker moet het onderwerp zelf noemen. Niet: een organisatie die al haar
// stukken met haar naam vult, en niets korter dan ankerMinLetters letters
// (ook niet als deel van een naamcombinatie als "dik_trompad").
function geldigAnker(term, ctx, F) {
  const delen = term.includes("_") ? term.split("_") : [term];
  return delen.every((d) => d.length >= F.ankerMinLetters && !ctx.org.has(d));
}

function factor(t, a, ctx) {
  let f = 1;
  const isParen = t.includes("_");
  if (ALGEMEEN.has(t)) f *= 0.05;
  if (ctx.template.has(t)) f *= 0.1;
  if (ctx.soort.has(t)) f *= 0.15;
  if (a.namen.has(t)) f *= 1.4;
  if (isParen) f *= t.split("_").every((d) => ALGEMEEN.has(d)) ? 0.05 : 0.6;
  else if (t.length < 5) f *= 0.6;
  return f;
}

/**
 * De zoekwoorden van één item: de woorden uit de kop (zwaarst), de eerste
 * 80 woorden van de tekst en de zwaarste termen uit de rest. Ankers zijn de
 * eigen, zeldzame woorden (zoals "Westerwateringtunnel"). Zonder anker kan
 * een item nooit rood worden.
 */
function bouwZoekvraag(a, ctx, F) {
  const kand = new Map();
  const zet = (t, delen) => {
    const w = ctx.idf(t) * factor(t, a, ctx) * delen;
    const oud = kand.get(t);
    if (oud === undefined || w > oud) kand.set(t, w);
  };
  for (const t of a.kopStammen) zet(t, 1);
  for (const t of a.introStammen) if (!kand.has(t)) zet(t, 0.6);
  const rest = [...a.telling.entries()]
    .filter(([t]) => !kand.has(t))
    .map(([t, n]) => [t, n * ctx.idf(t) * factor(t, a, ctx)])
    .sort((x, y) => y[1] - x[1])
    .slice(0, F.queryTekstTermen);
  for (const [t] of rest) zet(t, 0.4);

  const gesorteerd = [...kand.entries()].sort((x, y) => y[1] - x[1]).slice(0, F.queryMax);
  const maxW = gesorteerd.length ? gesorteerd[0][1] : 0;
  const dfGrens = Math.max(F.ankerDfMin, F.ankerDfRelatief * ctx.N);
  const groepen = gesorteerd
    .filter(([, w]) => w > 0)
    .map(([term, w]) => ({
      term,
      w,
      delen: deelTermen(term),
      anker:
        w >= F.ankerRelatief * maxW &&
        w >= F.ankerMinGewicht &&
        (ctx.df.get(term) || 0) <= dfGrens &&
        geldigAnker(term, ctx, F),
    }));
  return { groepen, ankers: groepen.filter((g) => g.anker).map((g) => g.term) };
}

function aanwezig(sets, g) {
  if (sets.alle.has(g.term)) return 1;
  if (g.delen.length >= 2 && g.delen.every((d) => sets.alle.has(d))) return 0.8;
  return 0;
}

function inLijst(lijst, g) {
  if (lijst.has(g.term)) return true;
  return g.delen.length >= 2 && g.delen.every((d) => lijst.has(d));
}

/**
 * Welke bewaarde stukken gaan over dit item? Een stuk telt alleen mee als het
 * een anker bevat en minstens dekkingMin van het zoekwoordgewicht. De
 * centraliteit (0 tot 1) zegt hoe centraal het onderwerp in het stuk staat:
 *   anker in de kop            0,70 tot 1,00
 *   anker in de eerste alinea  0,45 tot 0,80
 *   alleen verderop            0,10 tot 0,50, naar dichtheid van het woord
 * Alleen in voorbijgaan genoemd (onder minCentraliteit) telt later niet mee.
 */
function zoekEvidentie(vraag, vingerafdrukken, uitsluiten, F) {
  const uit = [];
  const totaal = vraag.groepen.reduce((s, g) => s + g.w, 0);
  if (!(totaal > 0) || !vraag.ankers.length) return uit;
  for (const fp of vingerafdrukken) {
    if (uitsluiten(fp)) continue;
    const sets = setsVan(fp);
    let gevonden = 0;
    let ankerAantal = 0;
    let ankerKop = false;
    let ankerIntro = false;
    const treffers = [];
    for (const g of vraag.groepen) {
      const p = aanwezig(sets, g);
      if (!p) continue;
      gevonden += g.w * p;
      if (g.anker) {
        treffers.push(g.term);
        ankerAantal += (fp.termen && fp.termen[g.term]) || 1;
        if (inLijst(sets.kop, g)) ankerKop = true;
        else if (inLijst(sets.intro, g)) ankerIntro = true;
      }
    }
    if (!treffers.length) continue;
    const dekking = gevonden / totaal;
    if (dekking < F.dekkingMin) continue;
    const dek = Math.min(1, dekking / 0.6);
    const per100 = (ankerAantal / Math.max(fp.woorden || 0, 80)) * 100;
    const dicht = Math.min(1, per100 / 1.5);
    let c;
    let plek;
    if (ankerKop) {
      c = 0.7 + 0.3 * dek;
      plek = "kop";
    } else if (ankerIntro) {
      c = 0.45 + 0.25 * dek + 0.1 * dicht;
      plek = "intro";
    } else {
      c = 0.1 + 0.4 * dicht * (0.5 + 0.5 * dek);
      plek = "tekst";
    }
    uit.push({
      k: fp.k,
      url: fp.url,
      bron: fp.bron,
      datum: fp.datum,
      titel: fp.titel,
      woorden: fp.woorden || 0,
      impact: fp.impact || {},
      c: Math.min(1, c),
      dekking,
      plek,
      treffers,
      kop: sets.kop,
    });
  }
  return uit;
}

function titelGelijkenis(a, b) {
  if (!a.size || !b.size) return 0;
  let gemeen = 0;
  for (const t of a) if (b.has(t)) gemeen++;
  return gemeen / (a.size + b.size - gemeen);
}

/**
 * De reeksregel. Een bron die steeds hetzelfde soort stuk publiceert (een
 * reeks verkeersbesluiten, een reeks bekendmakingen over graven) laat de
 * stukken op elkaar lijken zonder dat ze over hetzelfde onderwerp gaan. Twee
 * stukken van dezelfde bron met bijna dezelfde kop (kopgelijkenis van minstens
 * reeksJaccard) zijn daarom één reeks:
 *   - een stuk uit de reeks van het item zelf telt niet als bewijs;
 *   - van de rest telt per reeks alleen het meest centrale stuk.
 * Andere bronnen tellen gewoon apart mee: hetzelfde nieuws via meer bronnen
 * is meer bewijs. Stukken onder minCentraliteit vallen hier ook af.
 *
 * @param {object[]} evidentie  uit zoekEvidentie
 * @param {{bron: string, kop: Iterable<string>}} eigen  bron en kopstammen van het item
 */
function pasReeksregelToe(evidentie, eigen, F) {
  const eigenKop = new Set(eigen && eigen.kop ? eigen.kop : []);
  const eigenBron = eigen && eigen.bron;
  const zelfdeReeks = (bronA, kopA, bronB, kopB) =>
    bronA && bronA === bronB && titelGelijkenis(kopA, kopB) >= F.reeksJaccard;

  const rij = evidentie
    .filter((e) => e.c >= F.minCentraliteit)
    .filter((e) => !zelfdeReeks(eigenBron, eigenKop, e.bron, e.kop))
    .sort((x, y) => y.c - x.c);
  const gezien = [];
  const uit = [];
  for (const e of rij) {
    const dubbel = gezien.some((g) => zelfdeReeks(g.bron, g.kop, e.bron, e.kop));
    gezien.push(e);
    if (!dubbel) uit.push(e);
  }
  return uit;
}

module.exports = {
  maakVingerafdruk,
  analyseUitVingerafdruk,
  bouwContext,
  bouwZoekvraag,
  zoekEvidentie,
  pasReeksregelToe,
};
