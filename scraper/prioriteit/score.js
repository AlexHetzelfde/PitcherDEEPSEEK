// prioriteit/score.js
//
// De formule. Twee routes naar een hoge score; de hoogste telt.
//
//   AANHOUDEND  een onderwerp dat al een tijd leeft:
//               kern = (volume x duur x diepte)^(1/3)
//               volume  hoeveel stukken, naar centraliteit en verval
//               duur    over hoeveel verschillende dagen
//               diepte  hoeveel woorden eraan besteed zijn
//               score   = kern x (1 + 0,30 breedte + 0,30 impact)
//
//   PIEK        veel in de laatste 48 uur, uit meerdere bronnen, MET impact:
//               kern = (intensiteit x breedte x diepte)^(1/3), x (1 + 0,60 impact)
//               Zonder impact-signaal telt deze route niet: een incident met
//               veel artikelen is dan nog geen groot onderwerp. Voor de piek
//               telt alleen echte impact (orde, conflict, aantal getroffenen,
//               geld). Ambtelijke woorden als "besluit" of "voorziening" zijn
//               geen reden voor een piek: drie officiële stukken over een
//               gewoon verkeersbesluit zijn geen groot onderwerp.
//
// Alle bronnen wegen gelijk. Elk stuk telt één keer (één per url, ook als het
// bericht bijgewerkt wordt). Een extra stuk kan de score nooit verlagen.

"use strict";

const IMPACT_GEWICHT = Object.freeze({
  orde: 0.45,
  conflict: 0.3,
  voorziening: 0.25,
  aantal: 0.2,
  geld: 0.2,
  besluit: 0.2,
});

// De categorieën die de piekroute openen en versterken.
const PIEK_CATS = Object.freeze(["orde", "conflict", "aantal", "geld"]);

const DAG_MS = 24 * 3600 * 1000;

function sat(x, k) {
  return x <= 0 ? 0 : x / (x + k);
}

function leeftijdDagen(datum, nu) {
  const t = Date.parse(datum);
  if (!Number.isFinite(t)) return 30;
  return Math.max(0, (nu.getTime() - t) / DAG_MS);
}

function verval(leeftijd, F) {
  return Math.pow(0.5, leeftijd / F.halfwaardeDagen);
}

/**
 * Impact-signaal K (0 tot 1): hoeveel impactwoorden staan er in het item zelf
 * en in de stukken erover, naar centraliteit en verval. Standaard over alle
 * categorieën; met `cats` alleen over de genoemde (zie PIEK_CATS).
 */
function berekenImpact(eigenImpact, evidentie, nu, F, cats = null) {
  const lijst = cats || Object.keys(IMPACT_GEWICHT);
  const som = {};
  for (const cat of lijst) som[cat] = 0;
  const tel = (impact, gewicht) => {
    for (const cat of lijst) {
      som[cat] += gewicht * Math.min(3, (impact && impact[cat]) || 0);
    }
  };
  if (eigenImpact) tel(eigenImpact, 1);
  for (const e of evidentie) tel(e.impact, e.c * verval(leeftijdDagen(e.datum, nu), F));
  let K = 0;
  for (const cat of lijst) K += IMPACT_GEWICHT[cat] * sat(som[cat], 1.0);
  return Math.min(1, K);
}

function leegScore(K, Kp) {
  return { S: 0, Sa: 0, Sp: 0, route: "geen", n: 0, dagen: 0, bronnen: 0, K: K || 0, Kp: Kp || 0 };
}

/**
 * @param {number} K   impact over alle categorieën (versterkt de aanhoudende route)
 * @param {number} [Kp] impact over PIEK_CATS (opent en versterkt de piekroute);
 *                      zonder opgave geldt K
 */
function berekenScore(evidentie, K, nu, F, Kp = K) {
  const A = evidentie
    .filter((e) => e.c >= F.minCentraliteit)
    .map((e) => ({ ...e, leeftijd: leeftijdDagen(e.datum, nu) }));
  if (!A.length) return leegScore(K, Kp);

  let nEff = 0;
  let dEff = 0;
  const dag = new Map();
  const bronnen = new Set();
  for (const a of A) {
    const d = verval(a.leeftijd, F);
    nEff += a.c * d;
    dEff += a.woorden * d;
    bronnen.add(a.bron);
    const dk = Math.floor(a.leeftijd);
    dag.set(dk, Math.max(dag.get(dk) || 0, a.c * d));
  }
  let tEff = 0;
  for (const v of dag.values()) tEff += v;

  const B = sat(bronnen.size - 1, F.kBreedte);
  const Sa =
    Math.cbrt(sat(nEff, F.kVolume) * sat(tEff, F.kDuur) * sat(dEff, F.kDiepte)) *
    (1 + F.weegBreedte * B + F.weegImpact * K);

  let Sp = 0;
  const recent = A.filter((a) => a.leeftijd <= F.pieksVensterDagen);
  if (recent.length && Kp >= F.impactDrempelPiek) {
    let nI = 0;
    let dI = 0;
    const bI = new Set();
    for (const a of recent) {
      nI += a.c;
      dI += a.woorden;
      bI.add(a.bron);
    }
    Sp =
      Math.cbrt(sat(nI, F.kPiek) * sat(bI.size - 1, F.kBreedte) * sat(dI, F.kDiepte)) *
      (1 + F.weegImpactPiek * Kp);
  }

  return {
    S: Math.max(Sa, Sp),
    Sa,
    Sp,
    route: Sp > Sa ? "piek" : "aanhoudend",
    n: A.length,
    dagen: dag.size,
    bronnen: bronnen.size,
    K,
    Kp,
  };
}

function mediaan(gesorteerd) {
  const n = gesorteerd.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? gesorteerd[m] : (gesorteerd[m - 1] + gesorteerd[m]) / 2;
}

/**
 * De drempel tau voor rood: nooit onder tauMin, en bij een druk dagbeeld
 * hoger: mediaan + 3 x MAD van alle scores van deze run. Met minder dan
 * tauMinItems scores is dat niet betrouwbaar en geldt tauMin.
 */
function bepaalTau(scores, F) {
  const s = scores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length < F.tauMinItems) return F.tauMin;
  const med = mediaan(s);
  const mad = mediaan(s.map((x) => Math.abs(x - med)).sort((a, b) => a - b)) * 1.4826;
  return Math.min(F.tauMax, Math.max(F.tauMin, med + F.tauMadFactor * mad));
}

module.exports = { IMPACT_GEWICHT, PIEK_CATS, sat, leeftijdDagen, berekenImpact, berekenScore, bepaalTau };
