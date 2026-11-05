// prioriteit/geheugen.js
//
// Wat de prioriteitsfunctie onthoudt tussen runs, in data/zanp-prioriteit/:
//   geheugen.json    vingerafdrukken (kernfeiten per stuk, ±30 dagen), kandidaten
//                    (items boven de drempel, nog niet bevestigd) en rode items
//   schaduwlog.json  scores, onderdelen en redenen van de laatste run, plus de
//                    hoogste scores per dag (14 dagen), om de formule bij te stellen
//   teksten-JJJJ-MM-DD.jsonl   alle volledige teksten, één bestand per dag
//
// Dit zijn eigen bestanden: de pitchrun raakt ze niet aan en zij raken
// data/*.json van de pitchrun niet aan.

"use strict";

const fs = require("fs/promises");
const path = require("path");

const DAG_MS = 24 * 3600 * 1000;

function mapVan(env) {
  const basis = (env && env.ZANP_DATA_DIR) || path.join(__dirname, "..", "..", "data");
  return path.join(basis, "zanp-prioriteit");
}

function object(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function normaliseer(j) {
  const o = object(j);
  return { versie: 1, docs: object(o.docs), kandidaten: object(o.kandidaten), rood: object(o.rood) };
}

async function leesGeheugen(map) {
  try {
    const geheugen = normaliseer(JSON.parse(await fs.readFile(path.join(map, "geheugen.json"), "utf-8")));
    return { geheugen, voor: JSON.stringify(geheugen) };
  } catch {
    const geheugen = normaliseer({});
    return { geheugen, voor: JSON.stringify(geheugen) };
  }
}

// Schrijft alleen als er iets veranderd is, zodat de uurlijkse commit klein blijft.
async function schrijfGeheugen(map, geheugen, voor, nu) {
  const na = JSON.stringify(geheugen);
  if (na === voor) return false;
  await fs.mkdir(map, { recursive: true });
  await fs.writeFile(
    path.join(map, "geheugen.json"),
    JSON.stringify({ bijgewerkt: nu.toISOString(), ...geheugen }),
    "utf-8"
  );
  return true;
}

// Vergeet stukken ouder dan geheugenDagen en rode items van meer dan roodBewaarDagen geleden.
function ruimOp(geheugen, nu, F) {
  let weg = 0;
  const docGrens = nu.getTime() - F.geheugenDagen * DAG_MS;
  for (const [k, fp] of Object.entries(geheugen.docs)) {
    const t = Date.parse(fp && fp.datum);
    if (Number.isFinite(t) && t < docGrens) {
      delete geheugen.docs[k];
      weg++;
    }
  }
  const roodGrens = nu.getTime() - F.roodBewaarDagen * DAG_MS;
  for (const [k, r] of Object.entries(geheugen.rood)) {
    const t = Date.parse(r && r.tot ? `${r.tot}T12:00:00Z` : r && r.sinds);
    if (Number.isFinite(t) && t < roodGrens) delete geheugen.rood[k];
  }
  return weg;
}

async function schrijfSchaduwlog(map, log, vandaag, topDezeRun, F) {
  let oud = {};
  try {
    oud = JSON.parse(await fs.readFile(path.join(map, "schaduwlog.json"), "utf-8"));
  } catch {
    oud = {};
  }
  const dagen = object(oud.dagen);
  const dag = object(dagen[vandaag]);
  for (const t of topDezeRun) {
    const vorig = dag[t.key];
    if (!vorig || t.S > vorig.S) dag[t.key] = { kop: t.kop, S: t.S, route: t.route, K: t.K, n: t.n, bronnen: t.bronnen };
  }
  dagen[vandaag] = Object.fromEntries(
    Object.entries(dag)
      .sort((a, b) => b[1].S - a[1].S)
      .slice(0, 25)
  );
  const dagSleutels = Object.keys(dagen).sort();
  for (const d of dagSleutels.slice(0, Math.max(0, dagSleutels.length - 14))) delete dagen[d];

  await fs.mkdir(map, { recursive: true });
  await fs.writeFile(
    path.join(map, "schaduwlog.json"),
    JSON.stringify({ ...log, formule: F, dagen }, null, 2),
    "utf-8"
  );
}

async function voegTekstenToe(map, dag, regels) {
  if (!regels.length) return;
  await fs.mkdir(map, { recursive: true });
  await fs.appendFile(
    path.join(map, `teksten-${dag}.jsonl`),
    regels.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

module.exports = { mapVan, leesGeheugen, schrijfGeheugen, ruimOp, schrijfSchaduwlog, voegTekstenToe };
