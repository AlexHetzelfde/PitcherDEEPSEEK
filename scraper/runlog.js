// runlog.js — het logboek van één ZANP-run
//
// Doel: per onderdeel (tekst, spelling, jubileum, dossiers, enz.) bijhouden wat
// er in deze run gebeurde, zodat je kunt zien wat werkt. Elk onderdeel heeft:
//   tellers      getallen die optellen (bijv. "geschreven": 12)
//   waarden      losse meetwaarden van deze run (bijv. "dekkingPct": 87)
//   voorbeelden  een paar echte gevallen om te beoordelen
//   regels       korte zinnen, ook meteen in het Actions-log gezet als
//                "[log:onderdeel] ..."
//
// Gebruik (in elke module, zonder iets door te geven):
//   const runlog = require("./runlog");
//   runlog.huidig().tel("tekst", "geschreven", 3);
// Buiten een run (bijvoorbeeld in tests) is huidig() een leeg logboek dat niets
// doet, zodat modules het altijd mogen aanroepen.
//
// Opslag: data/zanp-log.json met
//   runs   de laatste MAX_RUNS runs; de laatste DETAIL_RUNS met voorbeelden en
//          regels, de oudere alleen met tellers en waarden
//   dagen  per dag de som van alle tellers (14 dagen), om dagen te vergelijken
// Een fout bij het opslaan stopt de run nooit.

"use strict";

const MAX_RUNS = 72;
const DETAIL_RUNS = 24;
const MAX_DAGEN = 14;
const MAX_VOORBEELDEN = 12;
const MAX_REGELS = 25;
const MAX_TEKENS_REGEL = 300;

function kort(tekst, max = MAX_TEKENS_REGEL) {
  const t = String(tekst == null ? "" : tekst);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function maakRunLog({ nu = new Date(), konsole = console } = {}) {
  const start = Date.now();
  const onderdelen = {};

  function onderdeel(naam) {
    if (!onderdelen[naam]) onderdelen[naam] = { tellers: {}, waarden: {}, voorbeelden: [], regels: [] };
    return onderdelen[naam];
  }

  return {
    actief: true,
    nu,

    tel(naam, teller, n = 1) {
      const o = onderdeel(naam);
      o.tellers[teller] = (o.tellers[teller] || 0) + (Number.isFinite(n) ? n : 0);
    },

    zet(naam, waarde, inhoud) {
      onderdeel(naam).waarden[waarde] = inhoud;
    },

    voorbeeld(naam, inhoud, max = MAX_VOORBEELDEN) {
      const o = onderdeel(naam);
      if (o.voorbeelden.length < max) o.voorbeelden.push(inhoud);
    },

    regel(naam, tekst) {
      const o = onderdeel(naam);
      const zin = kort(tekst);
      konsole.log(`[log:${naam}] ${zin}`);
      if (o.regels.length < MAX_REGELS) o.regels.push(zin);
    },

    samenvatting() {
      return { onderdelen: JSON.parse(JSON.stringify(onderdelen)), duurMs: Date.now() - start };
    },

    // Een korte samenvatting voor het Actions-log, één regel per onderdeel.
    drukAf() {
      for (const [naam, o] of Object.entries(onderdelen)) {
        const delen = [
          ...Object.entries(o.tellers).map(([k, v]) => `${k}=${v}`),
          ...Object.entries(o.waarden).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`),
        ];
        if (delen.length) konsole.log(`[log:${naam}] samenvatting: ${delen.join(", ")}`);
      }
    },

    /**
     * Voegt deze run toe aan data/zanp-log.json.
     * @param {{leesJson: Function, schrijfJson: Function}} io  uit gedeeld.js
     */
    async bewaar(io, bestand = "zanp-log.json") {
      try {
        const oud = (await io.leesJson(bestand, null)) || {};
        const runs = Array.isArray(oud.runs) ? oud.runs : [];
        const dagen = oud.dagen && typeof oud.dagen === "object" ? oud.dagen : {};

        const s = this.samenvatting();
        const dag = nu.toISOString().slice(0, 10);
        runs.push({ tijd: nu.toISOString(), duurMs: s.duurMs, onderdelen: s.onderdelen });

        // Oudere runs: alleen tellers en waarden, zodat het bestand klein blijft.
        const afgeslankt = runs.slice(-MAX_RUNS).map((r, i, alle) => {
          if (i >= alle.length - DETAIL_RUNS) return r;
          const onderdelen = {};
          for (const [n, o] of Object.entries(r.onderdelen || {})) {
            onderdelen[n] = { tellers: o.tellers || {}, waarden: o.waarden || {} };
          }
          return { tijd: r.tijd, duurMs: r.duurMs, onderdelen };
        });

        const vandaag = (dagen[dag] = dagen[dag] || { runs: 0, tellers: {} });
        vandaag.runs += 1;
        for (const [n, o] of Object.entries(s.onderdelen)) {
          vandaag.tellers[n] = vandaag.tellers[n] || {};
          for (const [k, v] of Object.entries(o.tellers)) vandaag.tellers[n][k] = (vandaag.tellers[n][k] || 0) + v;
        }
        for (const d of Object.keys(dagen).sort().slice(0, Math.max(0, Object.keys(dagen).length - MAX_DAGEN))) {
          delete dagen[d];
        }

        await io.schrijfJson(bestand, {
          gegenereerdOp: nu.toISOString(),
          uitleg:
            "Per run per onderdeel: tellers (optellend), waarden (meting van die run), voorbeelden en regels. " +
            `De laatste ${DETAIL_RUNS} runs hebben voorbeelden en regels; 'dagen' telt de tellers per dag op.`,
          runs: afgeslankt,
          dagen,
        });
        return true;
      } catch (fout) {
        konsole.error(`[log] Logboek opslaan mislukte (de run gaat door): ${fout.message}`);
        return false;
      }
    },
  };
}

// Een logboek dat niets doet, voor code die buiten een run draait.
const LEEG = {
  actief: false,
  tel() {},
  zet() {},
  voorbeeld() {},
  regel() {},
  samenvatting() {
    return { onderdelen: {}, duurMs: 0 };
  },
  drukAf() {},
  async bewaar() {
    return false;
  },
};

let lopend = null;

function start(opties) {
  lopend = maakRunLog(opties);
  return lopend;
}

function huidig() {
  return lopend || LEEG;
}

function stop() {
  lopend = null;
}

module.exports = { start, huidig, stop, maakRunLog, kort, MAX_RUNS, DETAIL_RUNS };
