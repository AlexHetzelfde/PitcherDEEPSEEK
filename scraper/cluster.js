// cluster.js
//
// ZANP-fase 2 (2026-10-24): dubbel nieuws herkennen.
//
// Hetzelfde nieuwsfeit komt vaak via meerdere bronnen binnen (gemeente,
// De Orkaan, NHD). Deze module groepeert zulke berichten in een cluster.
// Er wordt NIETS verwijderd: elk bericht houdt zijn record en krijgt alleen
// een clusterId. De frontend toont één kaart per cluster (met de beste bron
// als primair en de overige als "ook gemeld door"). Zo is een foute match
// altijd terug te draaien.
//
// WERKING
//  1. Alleen berichten van de afgelopen 72 uur, per bericht de nieuwste versie.
//  2. Gelijkenis = cosinus op TF-IDF van de woorden uit kop, tekst en
//     brontitel, plus een bonus voor gedeelde postcodes, ECLI-nummers,
//     grote getallen en bedragen.
//     Berichten van dezelfde bron worden nooit samengevoegd (sjabloontitels
//     van officiële bronnen lijken sterk op elkaar maar gaan over andere zaken).
//  3. >= AUTO_DREMPEL: zelfde nieuwsfeit. Tussen TWIJFEL_DREMPEL en
//     AUTO_DREMPEL: de AI beslist (hooguit maxAI vragen per run; de
//     antwoorden worden bewaard, zodat een paar nooit twee keer wordt
//     gevraagd). Eronder: niet hetzelfde.
//  4. Samenvoegen met union-find; clusterId = groepId van het oudste bericht.
//
// BEPERKING: van berichten van andere redacties bewaren we alleen de kop;
// de gelijkenis is daar dus grover. Daarom beslist bij twijfel de AI.

const { woordenVan } = require("./agenda-regels");

const VENSTER_UREN = 72;
const AUTO_DREMPEL = 0.6;
const TWIJFEL_DREMPEL = 0.35;
const ENTITEIT_BONUS = 0.25;
const BESLISSING_BEWAAR_DAGEN = 7;

const HERKOMST_VOLGORDE = { officieel: 0, organisatie: 1, signaal: 2, onbekend: 3 };

function paarSleutel(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function documentTekst(r) {
  return `${r.kop || ""} ${r.kop || ""} ${r.bronTitel || ""} ${r.tekst || ""}`;
}

function entiteiten(r) {
  const t = `${r.kop || ""} ${r.bronTitel || ""} ${r.tekst || ""}`;
  const uit = new Set();
  for (const m of t.matchAll(/\b\d{4}\s?[A-Z]{2}\b/g)) uit.add(`pc:${m[0].replace(/\s/g, "")}`);
  for (const m of t.matchAll(/ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:\d+/gi)) uit.add(`ecli:${m[0].toUpperCase()}`);
  for (const m of t.matchAll(/\b\d{1,3}(?:\.\d{3})+\b|\b\d{4,}\b/g)) {
    const n = m[0].replace(/\./g, "");
    if (/^(19|20)\d{2}$/.test(n)) continue; // jaartallen zeggen niets
    uit.add(`getal:${n}`);
  }
  for (const m of t.matchAll(/(\d+(?:,\d+)?)\s*(miljoen|miljard)/gi)) uit.add(`bedrag:${m[1]}${m[2].toLowerCase()}`);
  return uit;
}

function tfidfVectoren(docs) {
  const df = new Map();
  const termen = docs.map((d) => {
    const tf = new Map();
    for (const w of woordenVan(d)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  const n = docs.length;
  return termen.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const idf = Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;
      const waarde = (1 + Math.log(c)) * idf;
      v.set(w, waarde);
      norm += waarde * waarde;
    }
    return { v, norm: Math.sqrt(norm) };
  });
}

function cosinus(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [klein, groot] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
  let punt = 0;
  for (const [w, x] of klein) {
    const y = groot.get(w);
    if (y) punt += x * y;
  }
  return punt / (a.norm * b.norm);
}

function nieuwsteVersies(records) {
  const perGroep = new Map();
  for (const r of records) {
    const v = perGroep.get(r.groepId);
    if (!v || (r.versie || 1) > (v.versie || 1)) perGroep.set(r.groepId, r);
  }
  return [...perGroep.values()];
}

/**
 * @param {object[]} records  alle berichten uit berichten.json
 * @param {object}   opties   {
 *   nu: Date,
 *   beslissingen: { [paarSleutel]: { zelfde: boolean, op: ISO } },
 *   vraagAI: async (paren: {sleutel, a, b}[]) => Map<sleutel, boolean|null>,
 *   maxAI: number
 * }
 * @returns {Promise<{ clusterVan: Map<groepId, clusterId>, clusters: Map<clusterId, groepId[]>,
 *                     beslissingen: object, stats: object }>}
 */
async function bouwClusters(records, opties = {}) {
  const nu = opties.nu || new Date();
  const grens = nu.getTime() - VENSTER_UREN * 3600 * 1000;
  const beslissingen = { ...(opties.beslissingen || {}) };
  const maxAI = opties.maxAI ?? 10;

  const recent = nieuwsteVersies(records).filter((r) => {
    const t = new Date(r.tijd).getTime();
    return !isNaN(t) && t >= grens;
  });

  const vectoren = tfidfVectoren(recent.map(documentTekst));
  const ents = recent.map(entiteiten);

  const ouder = recent.map((_, i) => i);
  const vind = (i) => (ouder[i] === i ? i : (ouder[i] = vind(ouder[i])));
  const voeg = (i, j) => {
    const a = vind(i);
    const b = vind(j);
    if (a !== b) ouder[Math.max(a, b)] = Math.min(a, b);
  };

  const stats = { vergeleken: 0, automatisch: 0, aiGevraagd: 0, aiJa: 0, aiNee: 0, uitgesteld: 0 };
  const twijfel = [];

  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i];
      const b = recent[j];
      if (a.groepId === b.groepId) continue;
      stats.vergeleken++;

      let sim = cosinus(vectoren[i], vectoren[j]);
      let gedeeld = false;
      for (const e of ents[i]) if (ents[j].has(e)) { gedeeld = true; break; }
      if (gedeeld) sim = Math.min(1, sim + ENTITEIT_BONUS);

      // Berichten van DEZELFDE bron worden nooit samengevoegd. Een officiële
      // bron publiceert veel berichten met dezelfde sjabloontitel
      // ("Kennisgeving burgemeester …", "Publicatie zakelijke omschrijving …")
      // over verschillende zaken; een journalist moet elke publicatie zien.
      // Dubbel nieuws is per definitie hetzelfde feit uit VERSCHILLENDE bronnen.
      if (a.bronId === b.bronId) continue;
      const auto = AUTO_DREMPEL;

      if (sim >= auto) {
        voeg(i, j);
        stats.automatisch++;
      } else if (sim >= TWIJFEL_DREMPEL) {
        const sleutel = paarSleutel(a.groepId, b.groepId);
        const eerder = beslissingen[sleutel];
        if (eerder) {
          if (eerder.zelfde) voeg(i, j);
        } else {
          twijfel.push({ sleutel, sim, i, j });
        }
      }
    }
  }

  // De AI beslist over de twijfelgevallen, de meest gelijkende eerst.
  twijfel.sort((x, y) => y.sim - x.sim);
  const teVragen = twijfel.slice(0, maxAI);
  stats.uitgesteld = Math.max(0, twijfel.length - teVragen.length);
  if (teVragen.length && typeof opties.vraagAI === "function") {
    const paren = teVragen.map(({ sleutel, i, j }) => ({
      sleutel,
      a: { titel: recent[i].kop, tekst: recent[i].tekst || recent[i].bronTitel, bronNaam: recent[i].bronNaam },
      b: { titel: recent[j].kop, tekst: recent[j].tekst || recent[j].bronTitel, bronNaam: recent[j].bronNaam },
    }));
    const antwoorden = await opties.vraagAI(paren);
    stats.aiGevraagd = paren.length;
    for (const { sleutel, i, j } of teVragen) {
      const zelfde = antwoorden.get(sleutel);
      if (zelfde === true || zelfde === false) {
        beslissingen[sleutel] = { zelfde, op: nu.toISOString() };
        if (zelfde) {
          voeg(i, j);
          stats.aiJa++;
        } else {
          stats.aiNee++;
        }
      }
    }
  }

  // Oude beslissingen opruimen.
  const bewaarGrens = nu.getTime() - BESLISSING_BEWAAR_DAGEN * 24 * 3600 * 1000;
  for (const [sleutel, b] of Object.entries(beslissingen)) {
    if (new Date(b.op).getTime() < bewaarGrens) delete beslissingen[sleutel];
  }

  // Clusters verzamelen; clusterId = groepId van het oudste bericht.
  const groepen = new Map();
  recent.forEach((r, i) => {
    const wortel = vind(i);
    if (!groepen.has(wortel)) groepen.set(wortel, []);
    groepen.get(wortel).push(r);
  });
  const clusterVan = new Map();
  const clusters = new Map();
  for (const leden of groepen.values()) {
    if (leden.length < 2) continue;
    leden.sort((x, y) => (x.eerstGezienOp < y.eerstGezienOp ? -1 : x.eerstGezienOp > y.eerstGezienOp ? 1 : x.groepId < y.groepId ? -1 : 1));
    const clusterId = leden[0].groepId;
    clusters.set(clusterId, leden.map((l) => l.groepId));
    for (const l of leden) clusterVan.set(l.groepId, clusterId);
  }
  stats.clusters = clusters.size;
  return { clusterVan, clusters, beslissingen, stats };
}

// Schrijft clusterId op alle versies van elk bericht; haalt het weg waar
// een bericht niet (meer) in een cluster zit.
function pasClustersToe(records, clusterVan) {
  return records.map((r) => {
    const id = clusterVan.get(r.groepId);
    if (id) return r.clusterId === id ? r : { ...r, clusterId: id };
    if (r.clusterId) {
      const { clusterId, ...rest } = r;
      void clusterId;
      return rest;
    }
    return r;
  });
}

// Per cluster: hoeveel onafhankelijke bronnen en is er een officiële bron bij?
function clusterContext(records, clusterVan, clusters) {
  const perGroep = new Map(nieuwsteVersies(records).map((r) => [r.groepId, r]));
  const uit = new Map();
  for (const [clusterId, groepIds] of clusters) {
    const leden = groepIds.map((g) => perGroep.get(g)).filter(Boolean);
    uit.set(clusterId, {
      aantalBronnen: new Set(leden.map((l) => l.bronId)).size,
      heeftOfficieleBron: leden.some((l) => l.herkomst === "officieel"),
    });
  }
  return uit;
}

// De beste bron van een cluster: officieel, dan organisatie, dan signaal;
// bij gelijkspel het oudste bericht. De frontend doet hetzelfde.
function kiesPrimair(leden) {
  return [...leden].sort((a, b) => {
    const h = (HERKOMST_VOLGORDE[a.herkomst] ?? 3) - (HERKOMST_VOLGORDE[b.herkomst] ?? 3);
    if (h !== 0) return h;
    return a.eerstGezienOp < b.eerstGezienOp ? -1 : 1;
  })[0];
}

module.exports = { bouwClusters, pasClustersToe, clusterContext, kiesPrimair, paarSleutel, AUTO_DREMPEL, TWIJFEL_DREMPEL };
