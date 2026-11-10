// tekstarchief.js — de volledige teksten van berichten en agenda-items
//
// Eén opslag voor alle volledige teksten (ook van De Orkaan), in
// data/zanp-teksten/JJJJ-MM-DD.json: één bestand per PUBLICATIEDAG (Nederlandse
// kalenderdag van het bericht, niet de dag waarop het werd opgehaald). Zo weet
// de popup precies welk bestand hij nodig heeft, en vervalt een tekst precies
// bewaarDagen na publicatie.
//
// Inhoud van een dagbestand:
//   { dag, bijgewerkt, items: { "<sleutel>": { k, url, bron, versie, methode,
//                                              kop, datum, tekens, alineas, tekst } } }
// De sleutel is dezelfde als in de prioriteitsmodule: "n:<url>" voor een bericht,
// "a:<id>" voor een agenda-item. Van een bijgewerkt bericht (nieuwe versie)
// staat alleen de nieuwste tekst; `versie` zegt welke.
//
// Wat hier gebeurt bij het opslaan:
//   - alles gaat door schoonAlineas (tekstopschoning.js): rommelregels eruit,
//     alinea's herleid als er geen waren
//   - een tekst die al ouder is dan bewaarDagen wordt niet meer opgeslagen
//   - schrijven gebeurt alleen als er iets veranderd is (kleine uurcommits)
//
// Dit bestand vervangt de oude teksten-JJJJ-MM-DD.jsonl van de
// prioriteitsmodule (dagbestanden per OPHAALDAG). Die worden bij de eerstvolgende
// run overgezet en daarna verwijderd (migreerOudeBestanden).
//
// Alles wat hier gebeurt komt in het logboek (runlog.js) onder "tekst".

"use strict";

const fs = require("fs/promises");
const path = require("path");
const { kalenderdagAmsterdam } = require("./hulpmiddelen");
const { schoonAlineas } = require("./tekstopschoning");
const runlog = require("./runlog");

const DAG_MS = 24 * 3600 * 1000;
const BEWAAR_DAGEN = 14;
const MAX_TEKENS_PER_ITEM = 150_000;
const DAGBESTAND = /^(\d{4}-\d{2}-\d{2})\.json$/;
const OUD_BESTAND = /^teksten-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function mapVan(env) {
  const basis = (env && env.ZANP_DATA_DIR) || path.join(__dirname, "..", "data");
  return path.join(basis, "zanp-teksten");
}

function plusDagen(dag, n) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function leesDag(map, dag) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(map, `${dag}.json`), "utf-8"));
    return j && typeof j === "object" && j.items && typeof j.items === "object" ? j : { dag, items: {} };
  } catch {
    return { dag, items: {} };
  }
}

function dagVan(datum, terugval) {
  return kalenderdagAmsterdam(datum) || terugval;
}

/**
 * Slaat teksten op. Elke regel: { k, url, bron, versie, methode, kop, datum, tekst }.
 * @returns {Promise<object>} tellers van wat er gebeurde
 */
async function voegToe(map, regels, { vandaag, bewaarDagen = BEWAAR_DAGEN, log = runlog.huidig() } = {}) {
  const stats = {
    aangeboden: regels.length,
    geschreven: 0,
    ongewijzigd: 0,
    teOud: 0,
    leeg: 0,
    dagbestanden: 0,
    rommelRegels: 0,
    alineasHerleid: 0,
    titelWeg: 0,
    perMethode: {},
  };
  const grens = plusDagen(vandaag, -bewaarDagen);
  const perDag = new Map();
  const bronGezien = new Set();

  for (const r of regels) {
    if (!r || !r.k || !r.tekst) {
      stats.leeg++;
      continue;
    }
    const dag = dagVan(r.datum, vandaag);
    if (dag < grens) {
      stats.teOud++;
      continue;
    }
    // iBabs-teksten plakken hun velden met " — " aan elkaar; dat wordt een regel per veld.
    const splitOp = /^ibabs/i.test(String(r.bron || "")) ? " — " : null;
    const schoon = schoonAlineas(String(r.tekst).slice(0, MAX_TEKENS_PER_ITEM), { titel: r.kop, splitOp });
    if (!schoon.tekst) {
      stats.leeg++;
      continue;
    }
    stats.rommelRegels += schoon.rommelRegels;
    if (schoon.herleid) stats.alineasHerleid++;
    if (schoon.titelWeg) stats.titelWeg++;
    stats.perMethode[r.methode || "onbekend"] = (stats.perMethode[r.methode || "onbekend"] || 0) + 1;

    if (!perDag.has(dag)) perDag.set(dag, []);
    perDag.get(dag).push({
      k: r.k,
      url: r.url || null,
      bron: r.bron || null,
      versie: r.versie || 1,
      methode: r.methode || null,
      kop: r.kop || "",
      datum: r.datum || null,
      tekens: schoon.tekst.length,
      alineas: schoon.alineas,
      tekst: schoon.tekst,
    });

    // Eén voorbeeld per bron per run, om de opschoning te beoordelen.
    if (r.bron && !bronGezien.has(r.bron)) {
      bronGezien.add(r.bron);
      log.voorbeeld("tekst", {
        bron: r.bron,
        methode: r.methode || null,
        kop: String(r.kop || "").slice(0, 90),
        tekensVoor: String(r.tekst).length,
        tekensNa: schoon.tekst.length,
        alineas: schoon.alineas,
        rommelRegelsWeg: schoon.rommelRegels,
        alineasHerleid: schoon.herleid,
        begin: schoon.tekst.slice(0, 220),
        eind: schoon.tekst.slice(-120),
      });
    }
  }

  if (perDag.size) await fs.mkdir(map, { recursive: true });
  for (const [dag, items] of perDag) {
    const bestand = await leesDag(map, dag);
    const voor = JSON.stringify(bestand.items);
    for (const item of items) {
      const oud = bestand.items[item.k];
      if (oud && oud.versie > item.versie) {
        stats.ongewijzigd++;
        continue;
      }
      bestand.items[item.k] = item;
    }
    if (JSON.stringify(bestand.items) === voor) continue;
    await fs.writeFile(
      path.join(map, `${dag}.json`),
      JSON.stringify({ dag, bijgewerkt: new Date().toISOString(), items: bestand.items }),
      "utf-8"
    );
    stats.dagbestanden++;
    stats.geschreven += items.length;
  }

  log.tel("tekst", "aangeboden", stats.aangeboden);
  log.tel("tekst", "geschreven", stats.geschreven);
  log.tel("tekst", "teOudOvergeslagen", stats.teOud);
  log.tel("tekst", "leegOvergeslagen", stats.leeg);
  log.tel("tekst", "rommelRegelsWeg", stats.rommelRegels);
  log.tel("tekst", "alineasHerleid", stats.alineasHerleid);
  log.tel("tekst", "titelHerhalingWeg", stats.titelWeg);
  for (const [methode, n] of Object.entries(stats.perMethode)) log.tel("tekst", `methode-${methode}`, n);
  return stats;
}

/**
 * Verwijdert dagbestanden van publicatiedagen ouder dan bewaarDagen.
 * @returns {Promise<{verwijderd: number, bytes: number}>}
 */
async function ruimOp(map, vandaag, bewaarDagen = BEWAAR_DAGEN, log = runlog.huidig()) {
  let namen;
  try {
    namen = await fs.readdir(map);
  } catch {
    return { verwijderd: 0, bytes: 0 };
  }
  const grens = plusDagen(vandaag, -bewaarDagen);
  let verwijderd = 0;
  let bytes = 0;
  let oudste = null;
  for (const naam of namen.sort()) {
    const m = DAGBESTAND.exec(naam);
    if (!m) continue;
    if (m[1] >= grens) {
      if (!oudste) oudste = m[1];
      continue;
    }
    try {
      const stat = await fs.stat(path.join(map, naam));
      await fs.unlink(path.join(map, naam));
      verwijderd++;
      bytes += stat.size;
    } catch {
      // een volgende run probeert het opnieuw
    }
  }
  log.tel("tekst", "dagbestandenVerwijderd", verwijderd);
  log.tel("tekst", "bytesVerwijderd", bytes);
  if (oudste) log.zet("tekst", "oudsteDagbestand", oudste);
  return { verwijderd, bytes };
}

/**
 * Zet de oude teksten-JJJJ-MM-DD.jsonl (per ophaaldag, in zanp-prioriteit) over
 * naar de dagbestanden per publicatiedag en verwijdert ze daarna. Doet niets
 * als er geen oude bestanden meer zijn.
 * @returns {Promise<{bestanden: number, regels: number}>}
 */
async function migreerOudeBestanden(oudeMap, nieuweMap, { vandaag, bewaarDagen = BEWAAR_DAGEN, log = runlog.huidig() } = {}) {
  let namen;
  try {
    namen = (await fs.readdir(oudeMap)).filter((n) => OUD_BESTAND.test(n)).sort();
  } catch {
    return { bestanden: 0, regels: 0 };
  }
  let bestanden = 0;
  let aantal = 0;
  for (const naam of namen) {
    const regels = [];
    try {
      const inhoud = await fs.readFile(path.join(oudeMap, naam), "utf-8");
      for (const lijn of inhoud.split("\n")) {
        if (!lijn.trim()) continue;
        try {
          const o = JSON.parse(lijn);
          if (o && o.k && o.tekst) regels.push(o);
        } catch {
          // een kapotte regel slaan we over
        }
      }
      await voegToe(nieuweMap, regels, { vandaag, bewaarDagen, log });
      await fs.unlink(path.join(oudeMap, naam));
      bestanden++;
      aantal += regels.length;
    } catch (fout) {
      log.regel("tekst", `Oud tekstbestand ${naam} niet overgezet (volgende run opnieuw): ${fout.message}`);
    }
  }
  if (bestanden) log.regel("tekst", `${bestanden} oud(e) tekstbestand(en) overgezet (${aantal} regels) en verwijderd.`);
  log.tel("tekst", "oudeBestandenOvergezet", bestanden);
  return { bestanden, regels: aantal };
}

/**
 * Hoeveel berichten van de afgelopen bewaarDagen hebben een volledige tekst?
 * Per bron, in het logboek onder "tekst". Alleen de nieuwste versie per groep telt.
 * @returns {Promise<{berichten: number, metTekst: number, pct: number, perBron: object}>}
 */
async function dekking(map, records, { vandaag, bewaarDagen = BEWAAR_DAGEN, log = runlog.huidig() } = {}) {
  const grens = plusDagen(vandaag, -bewaarDagen);
  const tekens = new Map();
  let namen = [];
  try {
    namen = await fs.readdir(map);
  } catch {
    // nog geen archief
  }
  for (const naam of namen) {
    const m = DAGBESTAND.exec(naam);
    if (!m || m[1] < grens) continue;
    const bestand = await leesDag(map, m[1]);
    for (const [k, item] of Object.entries(bestand.items)) tekens.set(k, item.tekens || (item.tekst || "").length);
  }

  const laatste = new Map();
  for (const r of records) {
    const g = r.groepId || r.id;
    const o = laatste.get(g);
    if (!o || (r.versie || 1) > (o.versie || 1)) laatste.set(g, r);
  }

  const perBron = {};
  let berichten = 0;
  let metTekst = 0;
  for (const r of laatste.values()) {
    if (!r.url) continue;
    const dag = dagVan(r.tijd || r.eerstGezienOp, null);
    if (!dag || dag < grens) continue;
    const bron = r.bronId || "onbekend";
    const b = (perBron[bron] = perBron[bron] || { berichten: 0, metTekst: 0, tekens: 0 });
    b.berichten++;
    berichten++;
    const lengte = tekens.get(`n:${r.url}`);
    if (lengte) {
      b.metTekst++;
      b.tekens += lengte;
      metTekst++;
    }
  }
  const pct = berichten ? Math.round((metTekst / berichten) * 100) : 0;
  for (const b of Object.values(perBron)) {
    b.pct = b.berichten ? Math.round((b.metTekst / b.berichten) * 100) : 0;
    b.gemTekens = b.metTekst ? Math.round(b.tekens / b.metTekst) : 0;
    delete b.tekens;
  }

  log.zet("tekst", "dekkingPct", pct);
  log.zet("tekst", "berichtenZonderTekst", berichten - metTekst);
  log.zet("tekst", "dekkingPerBron", perBron);
  const zwak = Object.entries(perBron)
    .filter(([, b]) => b.berichten >= 2 && b.pct < 80)
    .sort((x, y) => x[1].pct - y[1].pct)
    .slice(0, 8)
    .map(([naam, b]) => `${naam} ${b.metTekst}/${b.berichten} (${b.pct}%)`);
  log.regel("tekst", `Dekking volledige tekst: ${metTekst}/${berichten} berichten (${pct}%).${zwak.length ? ` Laagst: ${zwak.join("; ")}.` : ""}`);
  return { berichten, metTekst, pct, perBron };
}

module.exports = {
  BEWAAR_DAGEN,
  mapVan,
  leesDag,
  voegToe,
  ruimOp,
  migreerOudeBestanden,
  dekking,
  plusDagen,
};
