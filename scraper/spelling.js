// spelling.js — controle op onbekende woorden in AI-koppen
//
// Aanleiding: de AI schreef koppen als "Inoner stuurt brief aan gemeenteraad"
// ("Inoner" voor "Inwoner") en "Inonerende brief". Dit is dezelfde soort
// harde controle als de cijfercontrole in wire.js, maar dan voor woorden.
//
// Een woord in de kop is goed als het
//   - minder dan 4 letters heeft, in hoofdletters staat (EBS) of een
//     merknaam is (iBabs), of
//   - een hoofdletter heeft en niet het eerste woord is (een naam: dat kan
//     het woordenboek niet controleren), of
//   - in de brontekst staat (de AI schrijft de kop uit die tekst), of
//   - een lokale plaatsnaam is, of
//   - in het Nederlandse woordenboek staat (nspell + dictionary-nl), of
//   - een samenstelling is van woorden uit het woordenboek (fietsbrug).
// Alleen een woord dat nergens aan voldoet, wordt een onbekend woord.
//
// Wat er dan gebeurt (controleerKop):
//   - Staat er voor elk onbekend woord een suggestie van het woordenboek die ook in
//     de brontekst voorkomt, dan wordt het woord daardoor vervangen (status "hersteld").
//     Een suggestie die niet in de bron staat, nemen we NIET over: de eerste
//     suggestie voor "Inonerende" is "Intonerende", en dat is erger.
//   - Anders valt de kop terug op de titel van de bron (status "terugval").
//   - Is het woordenboek niet geladen, dan gebeurt er niets (status
//     "niet-gecontroleerd"); de controle mag een run nooit blokkeren.
//
// Alles komt in het logboek (runlog.js) onder "spelling".

"use strict";

const runlog = require("./runlog");

const MIN_LETTERS = 4;
const MIN_DEEL = 4; // een deel van een samenstelling moet minstens zo lang zijn
const MAX_DIEPTE = 3;

const LOKAAL = new Set(
  [
    "zaanstreek", "zaanstad", "zaandam", "zaanse", "zaankanters", "krommenie", "krommeniedijk", "wormerveer", "zaandijk",
    "koog", "assendelft", "westzaan", "oostzaan", "wormer", "jisp", "haaldersbroek", "purmerend", "waterland", "landsmeer",
    "edam", "volendam", "marken", "monnickendam", "ilpendam", "beemster", "oostknollendam", "westknollendam", "rooswijk",
  ]
);

let spell = null;
let laden = null;
const samenstellingCache = new Map();

function isGeladen() {
  return Boolean(spell);
}

/**
 * Laadt het woordenboek (eenmalig per proces, ongeveer 0,7 s). Een fout hier
 * stopt de run niet; de controle slaat dan over.
 * @returns {Promise<boolean>}
 */
function laad(log = runlog.huidig()) {
  if (spell) return Promise.resolve(true);
  if (!laden) {
    laden = (async () => {
      try {
        const nspell = require("nspell");
        const woordenboek = await import("dictionary-nl");
        spell = nspell(woordenboek.default || woordenboek);
        log.regel("spelling", "Nederlands woordenboek geladen.");
        return true;
      } catch (fout) {
        log.regel("spelling", `Woordenboek niet geladen, koppen worden niet op spelling gecontroleerd: ${fout.message}`);
        return false;
      }
    })();
  }
  return laden;
}

// Voor tests: een eigen woordenboek met { correct(woord), suggest(woord) }.
function zetWoordenboek(w) {
  spell = w;
  laden = w ? Promise.resolve(true) : null;
  samenstellingCache.clear();
}

function goed(woord) {
  return woord.length >= MIN_DEEL && spell.correct(woord);
}

function isSamenstelling(woord, diepte = 1) {
  if (diepte === 1 && samenstellingCache.has(woord)) return samenstellingCache.get(woord);
  let uit = false;
  for (let i = MIN_DEEL; i <= woord.length - MIN_DEEL && !uit; i++) {
    const links = woord.slice(0, i);
    const rechts = woord.slice(i);
    const linksGoed =
      goed(links) || (links.endsWith("s") && goed(links.slice(0, -1))) || (links.endsWith("en") && goed(links.slice(0, -2)));
    if (!linksGoed) continue;
    if (goed(rechts) || (diepte < MAX_DIEPTE && rechts.length >= 2 * MIN_DEEL && isSamenstelling(rechts, diepte + 1))) uit = true;
  }
  if (diepte === 1) samenstellingCache.set(woord, uit);
  return uit;
}

function woordenIn(tekst) {
  return new Set((String(tekst || "").toLowerCase().match(/\p{L}+/gu) || []));
}

function isOnbekend(woord, index, bronWoorden) {
  if (woord.length < MIN_LETTERS) return false;
  if (woord === woord.toUpperCase()) return false; // EBS, NHD
  if (/\p{Ll}\p{Lu}/u.test(woord)) return false; // iBabs, WhatsApp
  const kleineLetters = woord.toLowerCase();
  if (index > 0 && woord[0] !== kleineLetters[0]) return false; // naam midden in de zin
  if (bronWoorden.has(kleineLetters) || LOKAAL.has(kleineLetters)) return false;
  if (spell.correct(woord) || spell.correct(kleineLetters)) return false;
  if (isSamenstelling(kleineLetters)) return false;
  return true;
}

function metHoofdletterVan(origineel, nieuw) {
  return origineel[0] !== origineel[0].toLowerCase() ? nieuw[0].toUpperCase() + nieuw.slice(1) : nieuw;
}

/**
 * Alle onbekende woorden in een tekst, met suggesties die in de bron voorkomen.
 * @returns {Array<{woord: string, start: number, einde: number, suggestie: string|null}>}
 */
function onbekendeWoorden(tekst, bron) {
  if (!spell) return [];
  const bronWoorden = woordenIn(bron);
  const uit = [];
  const re = /\p{L}+/gu;
  let m;
  let index = 0;
  while ((m = re.exec(String(tekst || ""))) !== null) {
    const woord = m[0];
    if (isOnbekend(woord, index, bronWoorden)) {
      let suggestie = null;
      for (const s of spell.suggest(woord).slice(0, 5)) {
        if (!/\s/.test(s) && bronWoorden.has(s.toLowerCase())) {
          suggestie = metHoofdletterVan(woord, s);
          break;
        }
      }
      uit.push({ woord, start: m.index, einde: m.index + woord.length, suggestie });
    }
    index++;
  }
  return uit;
}

/**
 * Controleert een kop en herstelt of vervangt hem als er onbekende woorden in staan.
 * @param {string} kop        de kop van de AI
 * @param {string} bron       de brontekst waaruit de AI de kop schreef
 * @param {string} terugval   de kop om op terug te vallen (de titel van de bron)
 * @returns {{kop: string, status: "ok"|"hersteld"|"terugval"|"niet-gecontroleerd", fouten: Array}}
 */
function controleerKop(kop, bron, terugval, log = runlog.huidig()) {
  if (!spell) {
    log.tel("spelling", "nietGecontroleerd");
    return { kop, status: "niet-gecontroleerd", fouten: [] };
  }
  log.tel("spelling", "gecontroleerd");
  const fouten = onbekendeWoorden(kop, bron);
  if (!fouten.length) {
    log.tel("spelling", "ok");
    return { kop, status: "ok", fouten: [] };
  }

  const alleHerstelbaar = fouten.every((f) => f.suggestie);
  const voorbeeld = (status, nieuw) => ({
    status,
    voor: String(kop).slice(0, 110),
    na: String(nieuw).slice(0, 110),
    fouten: fouten.map((f) => ({ woord: f.woord, suggestie: f.suggestie })),
  });

  if (alleHerstelbaar) {
    let nieuw = "";
    let tot = 0;
    for (const f of fouten) {
      nieuw += kop.slice(tot, f.start) + f.suggestie;
      tot = f.einde;
    }
    nieuw += kop.slice(tot);
    log.tel("spelling", "hersteld");
    log.voorbeeld("spelling", voorbeeld("hersteld", nieuw));
    log.regel("spelling", `Kop hersteld: "${kop.slice(0, 70)}" → "${nieuw.slice(0, 70)}" (${fouten.map((f) => `${f.woord}→${f.suggestie}`).join(", ")})`);
    return { kop: nieuw, status: "hersteld", fouten };
  }

  log.tel("spelling", "terugval");
  log.voorbeeld("spelling", voorbeeld("terugval", terugval));
  log.regel("spelling", `Kop teruggevallen op brontitel: "${kop.slice(0, 70)}" (onbekend: ${fouten.map((f) => f.woord).join(", ")})`);
  return { kop: terugval, status: "terugval", fouten };
}

/**
 * Alleen voor het logboek: hoeveel onbekende woorden staan er in een tekst?
 * Verandert niets aan de tekst.
 */
function telTekstFouten(tekst, bron, log = runlog.huidig()) {
  if (!spell) return 0;
  const fouten = onbekendeWoorden(tekst, bron);
  if (fouten.length) {
    log.tel("spelling", "tekstenMetOnbekendWoord");
    log.tel("spelling", "tekstOnbekendeWoorden", fouten.length);
    log.voorbeeld("spelling", { soort: "tekst", woorden: fouten.slice(0, 5).map((f) => f.woord) });
  }
  return fouten.length;
}

module.exports = { laad, isGeladen, zetWoordenboek, controleerKop, onbekendeWoorden, telTekstFouten };
