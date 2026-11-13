// dossiers.js — doorlopende onderwerpen ("dossiers") in de nieuwsstroom
//
// Een dossier ontstaat als er over hetzelfde onderwerp vaak genoeg is bericht
// (bijvoorbeeld de busbrug). Het blijft bestaan als lijst van kop + link, ook
// nadat de tekst van de berichten na 14 dagen is verdwenen.
//
// HOE HET WERKT (elke run)
//   1. Stubs. Van elk bericht bewaren we een klein "stub" (kop, link, bron,
//      datum) 60 dagen, ook als het bericht zelf al uit berichten.json is.
//   2. Unieke verhalen. Berichten die over dezelfde gebeurtenis gaan (een
//      cluster uit cluster.js) of bijna dezelfde brontitel hebben bij dezelfde
//      bron (de vier inwonersbrieven) tellen als één verhaal.
//   3. Kandidaat. Een zeldzaam woord dat in minstens 5 unieke verhalen staat,
//      verspreid over minstens 2 dagen, binnen 60 dagen, en dat nog bij geen
//      dossier hoort, is een kandidaat. De woorden worden telkens op stam
//      vergeleken (planten = plant).
//   4. Eén AI-controle per kandidaat (geen batch). De AI zegt of het echt één
//      onderwerp is, geeft het een naam en een tag en kiest 2 tot 3 zoekwoorden.
//      Het script controleert die zoekwoorden zelf tegen de koppen.
//   5. Daarna beslist alleen het script: een nieuw bericht hoort bij een
//      dossier als een zoekwoord in de kop staat, of twee verschillende
//      zoekwoorden in kop of brontitel.
//   6. Verval. Een dossier zonder nieuw bericht gaat na 90 dagen weg.
//
// MODUS (ZANP_DOSSIER_MODUS): "uit", "log" (standaard) of "aan". In "log" wordt
// alles berekend en bewaard, maar de frontend toont niets. Het bestand zegt in
// zijn veld `modus` welke stand het is.
//
// Deze module praat zelf niet met Google en niet met schijf: zanp.js geeft de
// AI-aanroep (vraagAI) en de bestanden mee en schrijft het resultaat weg. Alles
// komt in het logboek (runlog.js) onder "dossiers".

"use strict";

const crypto = require("crypto");
const runlog = require("./runlog");
const spelling = require("./spelling");
const { kalenderdagAmsterdam } = require("./hulpmiddelen");

const DAG_MS = 24 * 3600 * 1000;

const INST = {
  stubDagen: 60,
  minVerhalen: 5,
  minDagen: 2,
  vervalDagen: 90,
  maxControlesPerRun: 3,
  hervraagNaExtra: 3, // een afgewezen kandidaat opnieuw bekijken bij minstens +3 verhalen...
  hervraagFactor: 1.5, // ...en minstens anderhalf keer zoveel (een vaste naam komt anders steeds terug)
  minInKop: 3, // het woord moet in minstens 3 koppen staan, niet alleen in brontitels
  gedektDeel: 0.6, // zoveel van de verhalen al in een dossier: geen nieuwe kandidaat
  samenvoegAls: 0.7, // twee woorden met zoveel gelijke verhalen zijn één kandidaat
  duplicaatDagen: 3,
  duplicaatGelijk: 0.8, // brontitels zo gelijk bij dezelfde bron: één verhaal
  maxKoppenInPrompt: 14,
};

// Routinebronnen leveren geen verhalen: een dossier "vergunning" is geen dossier.
const ROUTINE_BRONNEN = new Set([
  "bekendmakingen",
  "wetenregelgeving",
  "zaanstad-ted",
  "zaanstad-tenderned",
  "zaanstad-camera",
  "zaanstad-kalender",
]);

// Functiewoorden, nieuwswoorden en plaatsnamen: geen onderwerp.
const STOP = new Set(
  `waar wordt worden werd werden heeft hebben hadden deze dient dienen tegen onder boven naast tussen tijdens vanaf vanwege
  binnen buiten tijdelijk tijdelijke nieuwe eerste tweede derde laatste laatst meer minder weinig enkele andere anders alle
  omdat terwijl hoewel echter altijd nooit vandaag gisteren morgen woensdag donderdag vrijdag zaterdag zondag maandag
  dinsdag jaren maand weken dagen uren minuten gemeente gemeenten gemeenteraad college raadsleden provincie provinciale
  zaanstad zaandam zaanstreek zaanse zaankanters krommenie wormerveer zaandijk assendelft westzaan oostzaan wormer hamming
  purmerend waterland holland nederland nederlandse mogelijk mogelijke volgens meldt melden gemeld vraagt stuurt willen
  moeten kunnen gaan komt komen krijgt krijgen maakt maken geeft geven neemt nemen laten houdt houden zoekt zoeken
  vindt vinden start opent sluit dicht vrijwillige verder verdere eigen gaat blijft blijven wordt zegt vinden bezig
  nodig mensen inwoners bewoners bewoner inwoner brief aandacht voorstel besluit besluiten kennisgeving collegebericht
  besluitenlijst vergadering vergaderingen overleg bijeenkomst informatie nieuws bericht berichten update aangehouden
  verdachte politie brandweer ambulance gewonden
  januari februari april juni juli augustus september oktober november december
  orkaan noord zaans nieuwsbrief motie moties amendement amendementen ingekomen stukken waarheen stelt voert verlengd
  verworpen aangenomen ingetrokken stichting stichtingen
  beschikbaar terug burgemeester vrouw vrouwen mannen amsterdam haarlem alkmaar helder utrecht almere hoofddorp vervoerregio`
    .split(/\s+/)
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// Woorden en stammen
// ---------------------------------------------------------------------------

const KLINKERS = /[aeiou]$/;

// Eenvoudige stam: meervoud en verbuiging eraf (planten → plant, bruggen → brug).
function stam(woord) {
  let w = woord;
  if (w.length > 6 && w.endsWith("en")) {
    w = w.slice(0, -2);
    if (w.length >= 5 && w[w.length - 1] === w[w.length - 2] && !KLINKERS.test(w)) w = w.slice(0, -1);
  } else if (w.length > 6 && w.endsWith("e")) {
    w = w.slice(0, -1);
  } else if (w.length > 5 && w.endsWith("s")) {
    w = w.slice(0, -1);
  }
  return w.length >= 5 ? w : woord;
}

// Zoals stammen(), maar geeft per stam het woord zoals het in de tekst staat.
function stammenMetVorm(tekst) {
  const uit = new Map();
  for (const m of String(tekst || "").toLowerCase().matchAll(/\p{L}{5,}/gu)) {
    if (STOP.has(m[0])) continue;
    const s = stam(m[0]);
    if (!STOP.has(s) && !uit.has(s)) uit.set(s, m[0]);
  }
  return uit;
}

function stammen(tekst) {
  const uit = new Set();
  for (const m of String(tekst || "").toLowerCase().matchAll(/\p{L}{5,}/gu)) {
    if (STOP.has(m[0])) continue;
    const s = stam(m[0]);
    if (!STOP.has(s)) uit.add(s);
  }
  return uit;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let gemeen = 0;
  for (const x of a) if (b.has(x)) gemeen++;
  return gemeen / (a.size + b.size - gemeen);
}

function dagVan(iso) {
  try {
    return kalenderdagAmsterdam(iso) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Stubs
// ---------------------------------------------------------------------------

/**
 * Werkt het stubs-bestand bij met de berichten van deze run en ruimt oude stubs op.
 * Alleen de nieuwste versie per bericht (groepId) telt; routinebronnen niet.
 * @returns {{items: object, nieuw: number, bijgewerkt: number, verlopen: number}}
 */
function updateStubs(items, records, nu, inst = INST) {
  const uit = { ...(items || {}) };
  const laatste = new Map();
  for (const r of records) {
    const g = r.groepId || r.id;
    const o = laatste.get(g);
    if (!o || (r.versie || 1) > (o.versie || 1)) laatste.set(g, r);
  }
  let nieuw = 0;
  let bijgewerkt = 0;
  for (const [g, r] of laatste) {
    if (!r.url || !r.kop || ROUTINE_BRONNEN.has(r.bronId)) continue;
    const stub = {
      g,
      u: r.url,
      k: r.kop,
      bt: r.bronTitel && r.bronTitel !== r.kop ? r.bronTitel : "",
      b: r.bronId || "",
      n: r.bronNaam || "",
      t: r.tijd || r.eerstGezienOp || nu.toISOString(),
      c: r.clusterId || null,
      r: r.rubriek || null,
    };
    if (!uit[g]) nieuw++;
    else if (JSON.stringify(uit[g]) !== JSON.stringify(stub)) bijgewerkt++;
    uit[g] = stub;
  }
  const grens = nu.getTime() - inst.stubDagen * DAG_MS;
  let verlopen = 0;
  for (const [g, s] of Object.entries(uit)) {
    if (Date.parse(s.t) < grens) {
      delete uit[g];
      verlopen++;
    }
  }
  return { items: uit, nieuw, bijgewerkt, verlopen };
}

// ---------------------------------------------------------------------------
// 2. Unieke verhalen
// ---------------------------------------------------------------------------

/**
 * Geeft per stub (groepId) een verhaalsleutel. Stubs in hetzelfde cluster delen
 * hem; zonder cluster delen bijna gelijke brontitels van dezelfde bron binnen
 * een paar dagen hem (een briefactie telt als één verhaal).
 * @returns {Map<string, string>}
 */
function verhaalSleutels(stubs, inst = INST) {
  const lijst = Object.values(stubs).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const sleutel = new Map();
  const reps = []; // verhalen zonder cluster: { s, stub, titel }
  for (const stub of lijst) {
    if (stub.c) {
      sleutel.set(stub.g, `c:${stub.c}`);
      continue;
    }
    const titel = stammen(stub.bt || stub.k);
    const tijd = Date.parse(stub.t);
    const gelijk = reps.find(
      (r) =>
        r.stub.b === stub.b &&
        Math.abs(tijd - Date.parse(r.stub.t)) <= inst.duplicaatDagen * DAG_MS &&
        r.titel.size >= 2 &&
        titel.size >= 2 &&
        jaccard(r.titel, titel) >= inst.duplicaatGelijk
    );
    if (gelijk) {
      sleutel.set(stub.g, gelijk.s);
    } else {
      sleutel.set(stub.g, `g:${stub.g}`);
      reps.push({ s: `g:${stub.g}`, stub, titel });
    }
  }
  return sleutel;
}

// ---------------------------------------------------------------------------
// 3. Kandidaten
// ---------------------------------------------------------------------------

function verhalenVan(stubs, sleutels) {
  const verhalen = new Map();
  for (const stub of Object.values(stubs)) {
    const s = sleutels.get(stub.g);
    if (!verhalen.has(s)) verhalen.set(s, { s, stubs: [], kopWoorden: new Set(), alleWoorden: new Set(), dagen: new Set(), t: 0 });
    const v = verhalen.get(s);
    v.stubs.push(stub);
    for (const w of stammen(stub.k)) {
      v.kopWoorden.add(w);
      v.alleWoorden.add(w);
    }
    for (const w of stammen(stub.bt)) v.alleWoorden.add(w);
    const d = dagVan(stub.t);
    if (d) v.dagen.add(d);
    v.t = Math.max(v.t, Date.parse(stub.t));
  }
  return verhalen;
}

function dossierDekt(dossiers) {
  const termen = new Set();
  const urls = new Set();
  for (const d of dossiers) {
    for (const t of d.zoektermen || []) termen.add(stam(t.toLowerCase()));
    for (const i of d.items || []) urls.add(i.u);
    for (const u of d.uitgesloten || []) urls.add(u);
  }
  return { termen, urls };
}

/**
 * Zoekt woorden die in genoeg unieke verhalen staan en nog bij geen dossier horen.
 * @returns {{kandidaten: Array, verhalen: number, woorden: number}}
 */
function zoekKandidaten({ stubs, sleutels, dossiers, afgewezen = {}, inst = INST }) {
  const verhalen = verhalenVan(stubs, sleutels);
  const N = verhalen.size;
  const maxDf = Math.max(15, Math.round(N * 0.1));
  const dekt = dossierDekt(dossiers);

  const perWoord = new Map(); // woord -> Set(verhaalsleutels)
  const inKop = new Map(); // woord -> aantal verhalen met het woord in de kop
  const vormen = new Map(); // stam -> Map(vorm -> aantal): hoe het woord er in de koppen uitziet
  for (const v of verhalen.values()) {
    for (const stub of v.stubs) {
      for (const [st, vorm] of stammenMetVorm(stub.k)) {
        if (!vormen.has(st)) vormen.set(st, new Map());
        vormen.get(st).set(vorm, (vormen.get(st).get(vorm) || 0) + 1);
      }
    }
  }
  const vormVan = (st) => {
    const m = vormen.get(st);
    return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : st;
  };
  for (const v of verhalen.values()) {
    for (const w of v.alleWoorden) {
      if (!perWoord.has(w)) perWoord.set(w, new Set());
      perWoord.get(w).add(v.s);
    }
    for (const w of v.kopWoorden) inKop.set(w, (inKop.get(w) || 0) + 1);
  }

  const mogelijk = [];
  for (const [woord, set] of perWoord) {
    if (set.size < inst.minVerhalen || set.size > maxDf) continue;
    if ((inKop.get(woord) || 0) < inst.minInKop) continue;
    if (dekt.termen.has(woord)) continue;
    const dagen = new Set();
    let alInDossier = 0;
    for (const s of set) {
      const v = verhalen.get(s);
      for (const d of v.dagen) dagen.add(d);
      if (v.stubs.some((x) => dekt.urls.has(x.u))) alInDossier++;
    }
    if (dagen.size < inst.minDagen) continue;
    if (alInDossier / set.size >= inst.gedektDeel) continue;
    const eerder = afgewezen[woord];
    if (eerder && set.size < Math.max(eerder.aantal + inst.hervraagNaExtra, Math.ceil(eerder.aantal * inst.hervraagFactor))) continue;
    mogelijk.push({ woord, set });
  }

  // Woorden die steeds in dezelfde verhalen staan, zijn één kandidaat.
  mogelijk.sort((a, b) => b.set.size - a.set.size || a.woord.localeCompare(b.woord));
  const gekozen = [];
  for (const m of mogelijk) {
    const dubbel = gekozen.find((g) => jaccard(g.set, m.set) >= inst.samenvoegAls);
    if (dubbel) dubbel.ook.push(m.woord);
    else gekozen.push({ ...m, ook: [] });
  }

  const kandidaten = gekozen.map((g) => {
    const lijst = [...g.set]
      .map((s) => verhalen.get(s))
      .sort((a, b) => b.t - a.t)
      .map((v) => {
        const nieuwste = v.stubs.slice().sort((a, b) => Date.parse(b.t) - Date.parse(a.t))[0];
        return { s: v.s, stubs: v.stubs, kop: nieuwste.k, bron: nieuwste.n || nieuwste.b, tijd: nieuwste.t, rubriek: nieuwste.r };
      });
    return { woord: g.woord, vorm: vormVan(g.woord), ook: g.ook.map(vormVan), aantal: lijst.length, verhalen: lijst };
  });
  kandidaten.sort((a, b) => b.aantal - a.aantal || Date.parse(b.verhalen[0].tijd) - Date.parse(a.verhalen[0].tijd));
  return { kandidaten, verhalen: N, woorden: perWoord.size };
}

// ---------------------------------------------------------------------------
// 4. De AI-controle
// ---------------------------------------------------------------------------

function tagRegels(tags) {
  return (tags || []).map((t) => `  ${t.code}: ${t.naam}`).join("\n");
}

function bouwDossierPrompt(kandidaat, tags, inst = INST) {
  const lijst = kandidaat.verhalen.slice(0, inst.maxKoppenInPrompt);
  const regels = lijst.map((v, i) => `${i + 1}. [${String(v.tijd).slice(0, 10)}, ${v.bron}] ${v.kop}`).join("\n");
  const ook = kandidaat.ook.length ? ` (en ${kandidaat.ook.map((o) => `"${o}"`).join(", ")})` : "";
  return `Je helpt een lokale nieuwsredactie in de Zaanstreek (Nederland) bij het bijhouden van dossiers: een doorlopend onderwerp waar op verschillende momenten over is bericht, zoals een bouwproject, een conflict, een besluit dat nog niet klaar is of een langlopend incident.

Een rekenmodel vond ${kandidaat.aantal} berichten met het woord "${kandidaat.vorm || kandidaat.woord}"${ook}. Dit zijn de nieuwste ${lijst.length}:
${regels}

Beoordeel of een deel van deze berichten echt over één en hetzelfde doorlopende onderwerp gaat.

Antwoord "dossier": false als:
- de berichten het woord alleen toevallig delen en over verschillende zaken gaan;
- het gaat om een breed vak of een categorie (bijvoorbeeld verkeer, politie, weer, evenementen) in plaats van één concreet onderwerp;
- het routine of administratief is (vergunningen, bekendmakingen, agenda's, collegeberichten) zonder doorlopend verhaal.
Twijfel je, dan is het geen dossier.

TAG (kies precies één code uit deze lijst; het gaat erom waar het onderwerp OVER gaat):
${tagRegels(tags)}
  ALG: geen van bovenstaande past

Geef ALLEEN geldige JSON terug, geen markdown-fences en geen andere tekst:
{
  "dossier": true,
  "naam": "<korte naam van het onderwerp, maximaal 5 woorden>",
  "tag": "<code uit de lijst>",
  "zoektermen": ["<1 tot 3 woorden zoals ze in de koppen van dit onderwerp staan>"],
  "horenErbij": [<de nummers van de berichten die echt bij dit onderwerp horen>]
}
Is het geen dossier: { "dossier": false }`;
}

function meerderheid(waarden) {
  const tel = new Map();
  for (const w of waarden.filter(Boolean)) tel.set(w, (tel.get(w) || 0) + 1);
  return [...tel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "ALG";
}

/**
 * Controleert het antwoord van de AI. Geeft { dossier: false, reden } of
 * { dossier: true, naam, tag, zoektermen, leden } terug, of null bij een
 * onbruikbaar antwoord (dan wordt niets onthouden en proberen we het later nog eens).
 */
function valideerDossierAntwoord(data, kandidaat, tags, inst = INST) {
  if (!data || typeof data !== "object") return null;
  if (data.dossier === false) return { dossier: false, reden: "ai-nee" };
  if (data.dossier !== true) return null;

  const naam = typeof data.naam === "string" ? data.naam.trim().replace(/\s+/g, " ") : "";
  if (naam.length < 3 || naam.length > 60) return null;

  const lijst = kandidaat.verhalen.slice(0, inst.maxKoppenInPrompt);
  const nummers = Array.isArray(data.horenErbij) ? data.horenErbij.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= lijst.length) : [];
  const leden = [...new Set(nummers)].map((n) => lijst[n - 1]);
  if (leden.length < inst.minVerhalen) return { dossier: false, reden: "te-weinig-bij-elkaar" };

  const codes = new Set((tags || []).map((t) => t.code).concat("ALG"));
  const tag = typeof data.tag === "string" && codes.has(data.tag.trim()) ? data.tag.trim() : meerderheid(leden.map((l) => l.rubriek));

  // De zoektermen van de AI moeten echt in de koppen van de gekozen berichten staan.
  const kopWoorden = leden.map((l) => stammen(l.kop));
  const verifieerd = [];
  for (const t of Array.isArray(data.zoektermen) ? data.zoektermen : []) {
    const w = String(t || "").toLowerCase().match(/\p{L}{4,}/gu);
    if (!w || w.length !== 1) continue;
    const s = stam(w[0]);
    if (kopWoorden.filter((k) => k.has(s)).length >= 3 && !verifieerd.some((v) => stam(v) === s)) verifieerd.push(w[0]);
  }
  if (!verifieerd.some((v) => stam(v) === kandidaat.woord)) verifieerd.unshift(kandidaat.vorm || kandidaat.woord);
  return { dossier: true, naam, tag, zoektermen: verifieerd.slice(0, 3), leden };
}

// ---------------------------------------------------------------------------
// 5. Koppelen en verval
// ---------------------------------------------------------------------------

function zoekStammen(dossier) {
  return (dossier.zoektermen || []).map((t) => stam(String(t).toLowerCase()));
}

function pastBij(dossier, stub) {
  const st = zoekStammen(dossier);
  if (!st.length) return false;
  const kop = stammen(stub.k);
  if (st.some((s) => kop.has(s))) return true;
  const alle = new Set([...kop, ...stammen(stub.bt)]);
  return st.filter((s) => alle.has(s)).length >= 2;
}

function itemVan(stub) {
  return { u: stub.u, k: stub.k, n: stub.n, b: stub.b, t: stub.t };
}

function sorteerItems(items) {
  return items.slice().sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
}

/** Voegt stubs die bij een dossier passen toe (alleen het script, geen AI). */
function koppelStubs(dossiers, stubs) {
  let toegevoegd = 0;
  for (const d of dossiers) {
    const bekend = new Set((d.items || []).map((i) => i.u));
    const uit = new Set(d.uitgesloten || []);
    for (const stub of Object.values(stubs)) {
      if (bekend.has(stub.u) || uit.has(stub.u)) continue;
      if (!pastBij(d, stub)) continue;
      d.items.push(itemVan(stub));
      bekend.add(stub.u);
      toegevoegd++;
    }
    d.items = sorteerItems(d.items);
    d.laatsteBericht = d.items.length ? d.items[0].t : d.laatsteBericht;
  }
  return toegevoegd;
}

function maakDossier({ kandidaat, oordeel, stubs, nu }) {
  const naamControle = spelling.controleerKop(oordeel.naam, kandidaat.verhalen.map((v) => v.kop).join(" "), capitaliseer(kandidaat.vorm || kandidaat.woord));
  const naam = naamControle.kop;
  const leden = new Set(oordeel.leden.map((l) => l.s));
  const items = [];
  const uitgesloten = [];
  for (const v of kandidaat.verhalen) {
    for (const stub of v.stubs) {
      if (leden.has(v.s)) items.push(itemVan(stub));
      else uitgesloten.push(stub.u);
    }
  }
  const dossier = {
    id: `d${crypto.createHash("sha1").update(kandidaat.woord).digest("hex").slice(0, 8)}`,
    naam,
    tag: oordeel.tag,
    zoektermen: oordeel.zoektermen,
    aangemaaktOp: nu.toISOString(),
    laatsteBericht: null,
    uitgesloten,
    items: sorteerItems(items),
  };
  dossier.laatsteBericht = dossier.items[0] ? dossier.items[0].t : nu.toISOString();
  koppelStubs([dossier], stubs);
  return { dossier, spellingStatus: naamControle.status };
}

function capitaliseer(w) {
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

// ---------------------------------------------------------------------------
// Alles samen
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {Array}  p.records            alle berichten van deze run
 * @param {Date}   p.nu
 * @param {string} p.modus              "uit" | "log" | "aan"
 * @param {object} p.stubsBestand       { items } uit data/zanp-stubs.json
 * @param {object} p.dossiersBestand    { dossiers, afgewezen } uit data/zanp-dossiers.json
 * @param {Function|null} p.vraagAI     async (prompt) => { data, verzoeken }; mag een fout met .status gooien
 * @param {Array}  p.tags               [{ code, naam }]
 * @param {number} p.maxControles       hoeveel AI-controles er deze run nog mogen
 * @returns {Promise<{stubsBestand: object, dossiersBestand: object, stats: object, quotum: boolean}>}
 */
async function draaiDossiers({ records, nu, modus = "log", stubsBestand, dossiersBestand, vraagAI = null, tags = [], maxControles = INST.maxControlesPerRun, log = runlog.huidig(), inst = INST }) {
  const stats = {
    stubsNieuw: 0, stubsVerlopen: 0, stubsTotaal: 0, verhalen: 0, kandidaten: 0, aiControles: 0, aiJa: 0, aiNee: 0, aiFout: 0,
    nieuweDossiers: 0, itemsToegevoegd: 0, dossiersVerlopen: 0, dossiersActief: 0,
  };
  let quotum = false;

  // 1. stubs
  const stubRes = updateStubs((stubsBestand && stubsBestand.items) || {}, records, nu, inst);
  const stubs = stubRes.items;
  stats.stubsNieuw = stubRes.nieuw;
  stats.stubsVerlopen = stubRes.verlopen;
  stats.stubsTotaal = Object.keys(stubs).length;

  // bestaande dossiers; verval
  let dossiers = ((dossiersBestand && dossiersBestand.dossiers) || []).map((d) => ({ ...d, items: [...(d.items || [])], uitgesloten: [...(d.uitgesloten || [])] }));
  const afgewezen = { ...((dossiersBestand && dossiersBestand.afgewezen) || {}) };
  const vervalGrens = nu.getTime() - inst.vervalDagen * DAG_MS;
  const over = dossiers.filter((d) => Date.parse(d.laatsteBericht) >= vervalGrens);
  stats.dossiersVerlopen = dossiers.length - over.length;
  for (const d of dossiers.filter((x) => !over.includes(x))) log.regel("dossiers", `Dossier verlopen (geen nieuw bericht sinds ${String(d.laatsteBericht).slice(0, 10)}): ${d.naam}`);
  dossiers = over;
  for (const [woord, a] of Object.entries(afgewezen)) if (Date.parse(a.tijd) < nu.getTime() - inst.stubDagen * DAG_MS) delete afgewezen[woord];

  // 2 en 5. unieke verhalen en koppeling van nieuwe berichten aan bestaande dossiers
  stats.itemsToegevoegd += koppelStubs(dossiers, stubs);
  const sleutels = verhaalSleutels(stubs, inst);

  // 3 en 4. kandidaten en AI-controles
  const zoek = zoekKandidaten({ stubs, sleutels, dossiers, afgewezen, inst });
  stats.verhalen = zoek.verhalen;
  stats.kandidaten = zoek.kandidaten.length;
  log.zet("dossiers", "kandidatenDezeRun", zoek.kandidaten.slice(0, 8).map((k) => `${k.woord} (${k.aantal})`));

  const teDoen = zoek.kandidaten.slice(0, Math.max(0, Math.min(maxControles, inst.maxControlesPerRun)));
  const teDoenLijst = zoek.kandidaten.slice(0, Math.max(0, Math.min(maxControles, inst.maxControlesPerRun)) + 12);
  let gedaan = 0;
  for (const kandidaat of teDoenLijst) {
    if (gedaan >= teDoen.length) break;
    if (!vraagAI || quotum) break;
    // Een eerdere kandidaat van deze run kan dit onderwerp al in een dossier hebben gezet.
    const dekt = dossierDekt(dossiers);
    const gedekt = kandidaat.verhalen.filter((v) => v.stubs.some((x) => dekt.urls.has(x.u))).length;
    if (dekt.termen.has(kandidaat.woord) || gedekt / kandidaat.aantal >= inst.gedektDeel) {
      log.tel("dossiers", "kandidaatAlGedekt");
      continue;
    }
    gedaan++;
    stats.aiControles++;
    let antwoord;
    try {
      antwoord = await vraagAI(bouwDossierPrompt(kandidaat, tags, inst));
    } catch (fout) {
      stats.aiFout++;
      if (fout && fout.status === 429) {
        quotum = true;
        log.regel("dossiers", "AI-quotum bereikt tijdens de dossiercontrole; de rest wacht tot de volgende run.");
      } else {
        log.regel("dossiers", `AI-controle van "${kandidaat.woord}" mislukte (volgende run opnieuw): ${fout && fout.message}`);
      }
      continue;
    }
    const oordeel = valideerDossierAntwoord(antwoord && antwoord.data, kandidaat, tags, inst);
    if (!oordeel) {
      stats.aiFout++;
      log.regel("dossiers", `Onbruikbaar AI-antwoord voor "${kandidaat.woord}" (volgende run opnieuw).`);
      continue;
    }
    if (!oordeel.dossier) {
      stats.aiNee++;
      afgewezen[kandidaat.woord] = { aantal: kandidaat.aantal, tijd: nu.toISOString(), reden: oordeel.reden };
      log.voorbeeld("dossiers", { besluit: "geen dossier", woord: kandidaat.woord, aantal: kandidaat.aantal, reden: oordeel.reden, koppen: kandidaat.verhalen.slice(0, 4).map((v) => v.kop) });
      log.regel("dossiers", `Kandidaat "${kandidaat.woord}" (${kandidaat.aantal} verhalen): geen dossier (${oordeel.reden}).`);
      continue;
    }
    stats.aiJa++;
    const { dossier, spellingStatus } = maakDossier({ kandidaat, oordeel, stubs, nu });
    dossiers.push(dossier);
    stats.nieuweDossiers++;
    stats.itemsToegevoegd += dossier.items.length;
    log.voorbeeld("dossiers", { besluit: "nieuw dossier", naam: dossier.naam, tag: dossier.tag, zoektermen: dossier.zoektermen, berichten: dossier.items.length, naamSpelling: spellingStatus, koppen: dossier.items.slice(0, 5).map((i) => i.k) });
    log.regel("dossiers", `NIEUW DOSSIER "${dossier.naam}" [${dossier.tag}] zoektermen: ${dossier.zoektermen.join(", ")} — ${dossier.items.length} berichten.`);
  }

  stats.dossiersActief = dossiers.length;
  for (const [naam, waarde] of Object.entries(stats)) {
    if (["stubsTotaal", "verhalen", "kandidaten", "dossiersActief"].includes(naam)) log.zet("dossiers", naam, waarde);
    else log.tel("dossiers", naam, waarde);
  }
  log.zet("dossiers", "modus", modus);
  log.zet("dossiers", "dossiers", dossiers.map((d) => `${d.naam} (${d.items.length})`));

  return {
    stubsBestand: { versie: 1, bijgewerkt: nu.toISOString(), items: stubs },
    dossiersBestand: { versie: 1, modus, bijgewerkt: nu.toISOString(), dossiers: dossiers.sort((a, b) => Date.parse(b.laatsteBericht) - Date.parse(a.laatsteBericht)), afgewezen },
    stats,
    quotum,
  };
}

module.exports = {
  INST,
  ROUTINE_BRONNEN,
  stam,
  stammen,
  updateStubs,
  verhaalSleutels,
  zoekKandidaten,
  bouwDossierPrompt,
  valideerDossierAntwoord,
  koppelStubs,
  pastBij,
  maakDossier,
  draaiDossiers,
};
