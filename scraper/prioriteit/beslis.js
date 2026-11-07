// prioriteit/beslis.js
//
// Van scores naar rood. Regels:
//  - Rood is rood: een item dat al rood is wordt niet meer beoordeeld.
//  - Score boven tau in bevestigRuns opeenvolgende runs (standaard 2) voordat
//    iets rood wordt. Zakt de score ruim onder tau, dan begint het tellen opnieuw.
//  - Eén rood per onderwerp. Twee items horen bij hetzelfde onderwerp als het
//    belangrijkste zoekwoord (anker) van het ene bij de twee belangrijkste van
//    het andere hoort.
//      Agenda: alleen het eerstvolgende item van het onderwerp wordt rood, en
//      niets wat al voorbij is. Zolang een rood agenda-item van het onderwerp
//      nog moet komen, volgt er geen tweede; daarna kan het volgende item
//      eerstvolgend worden.
//      Nieuws: alleen een vers bericht (zie index.js), en het eerste erna;
//      daarna hooguit één per onderwerp per nieuwsTopicUren.
//  - Noodrem: worden er in één run meer dan noodremMax items nieuw rood, dan
//    blijven alleen de hoogste scores over en komt er een waarschuwing in het
//    log. Drie of vier tegelijk is gewoon.
//  - De AI mag alleen veto uitspreken (nooit rood maken, zie ai.js). Is er geen
//    aiVeto, of mislukt hij, dan beslist alleen de berekening. Een veto blijft
//    gelden zolang het item boven de drempel blijft; zakt het ruim eronder,
//    dan begint het opnieuw.

"use strict";

function afronden(x) {
  return Math.round(x * 100) / 100;
}

// Hetzelfde onderwerp: het belangrijkste anker van het ene zit bij de top-2 van het andere.
function zelfdeOnderwerp(a, b) {
  return a.length > 0 && b.length > 0 && (b.includes(a[0]) || a.includes(b[0]));
}

const topVan = (k) => k.topAnkers || [];
const roodTop = (r) => r.topAnker || (r.anker || []).slice(0, 2);

async function beslis({ kandidaten, tau, geheugen, nu, vandaag, F, aiVeto = null, log = console }) {
  const kand = geheugen.kandidaten;
  const rood = geheugen.rood;
  const stats = { boven: 0, wacht: 0, onderdrukt: 0, veto: 0, nieuwRood: 0, noodrem: false };
  const levend = new Set(kandidaten.map((k) => k.key));
  const promoveer = [];

  for (const k of kandidaten) {
    if (rood[k.key]) continue;
    if (k.score.S >= tau) {
      stats.boven++;
      const st = kand[k.key] || { runs: 0, eerst: nu.toISOString() };
      st.runs += 1;
      st.laatst = nu.toISOString();
      st.score = afronden(k.score.S);
      kand[k.key] = st;
      if (st.veto) continue;
      if (st.runs >= F.bevestigRuns) promoveer.push(k);
      else stats.wacht++;
    } else if (k.score.S < tau - F.hysterese) {
      delete kand[k.key];
    }
  }
  for (const key of Object.keys(kand)) if (!levend.has(key)) delete kand[key];

  promoveer.sort((a, b) => b.score.S - a.score.S);

  const topicGrens = F.nieuwsTopicUren * 3600 * 1000;
  const recentNieuws = Object.values(rood).filter(
    (r) => r.soort === "nieuws" && nu.getTime() - Date.parse(r.sinds) <= topicGrens
  );
  const actiefAgendaRood = Object.values(rood).filter((r) => r.soort === "agenda" && r.tot && r.tot >= vandaag);
  const gekozen = [];
  for (const k of promoveer) {
    const top = topVan(k);
    let botst = false;
    if (k.soort === "nieuws") {
      botst =
        recentNieuws.some((r) => zelfdeOnderwerp(top, roodTop(r))) ||
        gekozen.some((g) => g.soort === "nieuws" && zelfdeOnderwerp(top, topVan(g)));
    } else {
      // Agenda: niets uit het verleden, en alleen het eerstvolgende item van het onderwerp.
      const voorbij = Boolean(k.tot) && k.tot < vandaag;
      const alRood = actiefAgendaRood.some((r) => zelfdeOnderwerp(top, roodTop(r)));
      const eerder = kandidaten.some(
        (o) =>
          o !== k &&
          o.soort === "agenda" &&
          !rood[o.key] &&
          !(kand[o.key] && kand[o.key].veto) &&
          (o.tot || "") >= vandaag &&
          o.score.S >= tau &&
          zelfdeOnderwerp(top, topVan(o)) &&
          ((o.start || "") < (k.start || "") || ((o.start || "") === (k.start || "") && o.key < k.key))
      );
      botst = voorbij || alRood || eerder || gekozen.some((g) => g.soort === "agenda" && zelfdeOnderwerp(top, topVan(g)));
    }
    if (botst) {
      stats.onderdrukt++;
      continue;
    }
    gekozen.push(k);
  }

  let toegestaan = gekozen;
  if (aiVeto && gekozen.length) {
    try {
      const uitslag = await aiVeto(
        gekozen.map((k) => ({
          key: k.key,
          soort: k.soort,
          kop: k.kop,
          kern: k.kern,
          ankers: k.ankers,
          reden: k.reden,
          bewijs: k.bewijs,
        })),
        { maxVerzoeken: F.aiVerzoekenMax, perVerzoek: F.aiPerVerzoek }
      );
      toegestaan = gekozen.filter((k) => {
        const v = uitslag && typeof uitslag.get === "function" ? uitslag.get(k.key) : null;
        if (v === false) {
          stats.veto++;
          if (kand[k.key]) kand[k.key].veto = true;
          return false;
        }
        return true;
      });
    } catch (fout) {
      log.warn(`[prioriteit] AI-veto mislukte, de berekening beslist: ${fout.message}`);
    }
  }

  if (toegestaan.length > F.noodremMax) {
    stats.noodrem = true;
    log.warn(
      `[prioriteit] NOODREM: ${toegestaan.length} items willen tegelijk rood worden (grens ${F.noodremMax}). ` +
        `Alleen de hoogste ${F.noodremMax} gaan door. Controleer de drempel of de impactlijst.`
    );
    toegestaan = toegestaan.slice(0, F.noodremMax);
  }

  const nieuwRood = [];
  for (const k of toegestaan) {
    rood[k.key] = {
      soort: k.soort,
      sinds: nu.toISOString(),
      score: afronden(k.score.S),
      route: k.score.route,
      reden: k.reden,
      anker: k.ankers,
      topAnker: topVan(k),
      kop: k.kop,
      tot: k.tot || null,
    };
    delete kand[k.key];
    nieuwRood.push(k);
    stats.nieuwRood++;
  }
  return { stats, nieuwRood };
}

module.exports = { beslis };
