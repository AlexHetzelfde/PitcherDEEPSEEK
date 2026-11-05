// prioriteit/tekst.js
//
// Haalt van ALLE agenda-items en nieuwsberichten de volledige tekst op, voor
// de prioriteitsfunctie. Dit staat los van de bestaande tekststap van ZANP
// (die voor de AI op 6.000 tekens afkapt en voor sommige agendabronnen niets
// ophaalt): niets in die stap verandert.
//
//  - Zaanstad-hoorzittingen: detailpagina, met de detailSelector uit bronnen.js
//  - Zaanstad-kalender (iBabs): de agendapagina (agendapunten, stukken)
//  - Waarheen, De Orkaan, de rest: de artikelpagina
//  - Bronnen die nietOphalen zijn (iBabs-rapporten): de lijsttekst uit deze run
//
// Per run hooguit tekstMaxPerRun pagina's en tekstMaxSeconden; wat overblijft
// komt de volgende run aan de beurt (dichtstbijzijnde agenda eerst, daarna het
// nieuwste nieuws). Elke url wordt maar één keer opgehaald, behalve bij een
// bijgewerkt bericht of een mislukte poging (hooguit tekstMaxPogingen).

"use strict";

const cheerio = require("cheerio");
const { haalArtikelTekst, haalOp, MIN_BRUIKBARE_TEKST_TEKENS } = require("../hulpmiddelen");

const BESTANDSTYPE = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(\?|#|$)/i;
const WEG = "script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select";
const AFGEKAPT_VANAF = 5900;
const MIN_VOLLEDIG_TEKENS = 200;
const PAGINA_TIMEOUT_MS = 45_000;

function hostVan(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "onbekend";
  }
}

function schoonTekst(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function metTijdslimiet(belofte, ms) {
  belofte.catch(() => {});
  let timer;
  const limiet = new Promise((_, afwijzen) => {
    timer = setTimeout(() => afwijzen(new Error(`timeout na ${ms / 1000}s`)), ms);
  });
  return Promise.race([belofte, limiet]).finally(() => clearTimeout(timer));
}

// Reserve voor pagina's waar de gewone tekstherkenning niets vindt (bijvoorbeeld
// een iBabs-agendapagina): de hoofdtekst of anders alle tekst van de pagina.
async function haalPaginaTekst(url, maxTekens) {
  const html = await metTijdslimiet(haalOp(url, 2, { stil: true }), PAGINA_TIMEOUT_MS);
  if (!html || String(html).startsWith("%PDF-")) return "";
  const $ = cheerio.load(html);
  $(WEG).remove();
  const kandidaten = ["main", '[role="main"]', "#content", ".content", "body"];
  let beste = "";
  for (const sel of kandidaten) {
    const t = schoonTekst($(sel).first().text());
    if (t.length > beste.length && (t.length >= MIN_VOLLEDIG_TEKENS || sel === "body")) {
      beste = t;
      if (t.length >= MIN_VOLLEDIG_TEKENS) break;
    }
  }
  return beste.slice(0, maxTekens);
}

function plusDagen(dag, n) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function laatstePerGroep(records) {
  const laatste = new Map();
  for (const r of records) {
    const g = r.groepId || r.id;
    const o = laatste.get(g);
    if (!o || (r.versie || 1) > (o.versie || 1)) laatste.set(g, r);
  }
  return [...laatste.values()];
}

function agendaKomt(i, vandaag, F) {
  if (i.afkomst !== "bron" || i.zichtbaar === false || i.inAfwachting || i.doorlopend) return false;
  return i.eindDag >= plusDagen(vandaag, -1) && i.startDag <= plusDagen(vandaag, F.agendaVooruitDagen);
}

/**
 * Welke stukken moeten (opnieuw) opgehaald worden? Dichtstbijzijnde agenda
 * eerst, dan het nieuwste nieuws.
 */
function maakWerklijst({ records, agendaItems, docs, vandaag, nu, F, inst }) {
  const taken = [];
  const geheugenGrens = nu.getTime() - F.geheugenDagen * 24 * 3600 * 1000;
  const soonDag = plusDagen(vandaag, 3);

  for (const r of laatstePerGroep(records)) {
    if (!r.url) continue;
    const datum = r.tijd || r.eerstGezienOp;
    const t = Date.parse(datum);
    if (!Number.isFinite(t) || t < geheugenGrens) continue;
    const key = `n:${r.url}`;
    const oud = docs[key];
    if (oud && (oud.versie || 1) >= (r.versie || 1) && (oud.volledig || (oud.pogingen || 0) >= inst.tekstMaxPogingen)) continue;
    const jong = nu.getTime() - t <= 7 * 24 * 3600 * 1000;
    taken.push({
      key,
      soort: "nieuws",
      url: r.url,
      kop: r.bronTitel || r.kop || "",
      bron: r.bronId,
      datum,
      versie: r.versie || 1,
      groep: r.groepId || r.id,
      kort: r.tekst || "",
      pogingen: (oud && oud.pogingen) || 0,
      rang: jong ? 1 : 3,
      sorteer: -t,
    });
  }

  for (const i of agendaItems) {
    if (!agendaKomt(i, vandaag, F) || !i.url) continue;
    const key = `a:${i.id}`;
    const oud = docs[key];
    if (oud && (oud.volledig || (oud.pogingen || 0) >= inst.tekstMaxPogingen)) continue;
    taken.push({
      key,
      soort: "agenda",
      url: i.url,
      kop: i.kop || "",
      bron: i.bronId,
      datum: i.eerstGezienOp || nu.toISOString(),
      versie: 1,
      groep: null,
      kort: "",
      pogingen: (oud && oud.pogingen) || 0,
      rang: i.startDag <= soonDag ? 0 : 2,
      sorteer: Date.parse(`${i.startDag}T12:00:00Z`),
    });
  }

  taken.sort((a, b) => a.rang - b.rang || a.sorteer - b.sorteer);
  return taken;
}

function heeftLokaleTekst(taak, ctx) {
  const ruw = ctx.ruweVanUrl.get(taak.url);
  const lijst = ruw && typeof ruw.samenvatting === "string" ? ruw.samenvatting : "";
  if (lijst && ruw.tekstBron === "artikel" && lijst.length < AFGEKAPT_VANAF) {
    return { tekst: lijst, volledig: true, methode: "run" };
  }
  if (!taak.url || BESTANDSTYPE.test(taak.url) || ctx.nietOphalen(taak.bron)) {
    return {
      tekst: lijst || taak.kort || "",
      volledig: lijst.length >= MIN_VOLLEDIG_TEKENS,
      methode: lijst ? "lijst" : "kort",
      geenNieuwePoging: true,
    };
  }
  return null;
}

async function haalVoorTaak(taak, ctx) {
  const ruw = ctx.ruweVanUrl.get(taak.url);
  const lijst = ruw && typeof ruw.samenvatting === "string" ? ruw.samenvatting : "";
  let tekst = "";
  let methode = "kort";
  let gefaald = false;
  try {
    const uit = await haalArtikelTekst(taak.url, {
      titel: taak.kop,
      detailSelector: ctx.detailSelectorVoor(taak.bron),
      maxTekens: ctx.inst.tekstMaxTekens,
    });
    if (uit && uit.tekst) {
      tekst = uit.tekst;
      methode = "artikel";
    }
  } catch (fout) {
    gefaald = true;
    ctx.log.warn(`[prioriteit] Tekst ophalen mislukt voor ${taak.url}: ${fout.message}`);
  }
  if (!gefaald && tekst.length < MIN_BRUIKBARE_TEKST_TEKENS) {
    try {
      const pagina = await haalPaginaTekst(taak.url, ctx.inst.tekstMaxTekens);
      if (pagina.length > tekst.length) {
        tekst = pagina;
        methode = "pagina";
      }
    } catch (fout) {
      gefaald = true;
      ctx.log.warn(`[prioriteit] Pagina ophalen mislukt voor ${taak.url}: ${fout.message}`);
    }
  }
  if (tekst.length < MIN_VOLLEDIG_TEKENS && lijst.length > tekst.length) {
    tekst = lijst;
    methode = "lijst";
  }
  if (!tekst) tekst = taak.kort || "";
  return {
    tekst,
    volledig: (methode === "artikel" || methode === "pagina") && tekst.length >= MIN_VOLLEDIG_TEKENS,
    methode,
  };
}

/**
 * Haalt de teksten op voor een werklijst.
 * @returns {{resultaten: object[], stats: object}} resultaten: { taak, tekst, volledig, methode, geenNieuwePoging }
 */
async function haalTeksten(werklijst, ctx) {
  const stats = { werklijst: werklijst.length, lokaal: 0, opgehaald: 0, mislukt: 0, uitgesteld: 0 };
  const resultaten = [];
  const netwerk = [];
  for (const taak of werklijst) {
    const lokaal = heeftLokaleTekst(taak, ctx);
    if (lokaal) {
      resultaten.push({ taak, ...lokaal });
      stats.lokaal++;
    } else netwerk.push(taak);
  }

  const dezeRun = netwerk.slice(0, ctx.inst.tekstMaxPerRun);
  stats.uitgesteld = netwerk.length - dezeRun.length;
  const einde = Date.now() + ctx.inst.tekstMaxSeconden * 1000;

  const perHost = new Map();
  for (const taak of dezeRun) {
    const host = hostVan(taak.url);
    if (!perHost.has(host)) perHost.set(host, []);
    perHost.get(host).push(taak);
  }
  const wachtrij = [...perHost.values()];

  async function verwerkHost(lijst) {
    for (let i = 0; i < lijst.length; i++) {
      const taak = lijst[i];
      if (Date.now() > einde) {
        stats.uitgesteld += lijst.length - i;
        return;
      }
      const uit = await haalVoorTaak(taak, ctx);
      resultaten.push({ taak, ...uit });
      if (uit.volledig) stats.opgehaald++;
      else stats.mislukt++;
      if (i < lijst.length - 1) await new Promise((r) => setTimeout(r, ctx.inst.tekstPauzeMs));
    }
  }

  const werkers = Array.from(
    { length: Math.max(0, Math.min(ctx.inst.tekstParallel, wachtrij.length)) },
    async () => {
      while (wachtrij.length) await verwerkHost(wachtrij.shift());
    }
  );
  await Promise.all(werkers);
  return { resultaten, stats };
}

module.exports = { maakWerklijst, haalTeksten, agendaKomt, plusDagen, laatstePerGroep };
