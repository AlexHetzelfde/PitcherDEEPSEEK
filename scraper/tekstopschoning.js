// tekstopschoning.js — volledige teksten leesbaar maken voor de popup
//
// Twee taken:
//
// 1. ALINEA'S BEHOUDEN bij het halen van een artikel uit HTML. De bestaande
//    extractie (hulpmiddelen.js, voor de AI) maakt van alles één lange regel;
//    deze versie laat elke alinea, kop en opsommingsregel apart staan, gescheiden
//    door een lege regel. De selectorlogica is dezelfde (dezelfde inhoudsvlakken
//    en dezelfde weg-te-halen onderdelen), zodat de keuze van de tekst gelijk
//    blijft; alleen de opmaak blijft bewaard.
//
// 2. OPSCHONEN van tekst uit elke bron (artikel, iBabs, pdf, lijsttekst):
//    losse knoppen en doorverwijzingen ("Lees ook", "Delen", ...) en
//    fotobijschriften eruit, dubbele regels en een herhaalde titel eruit.
//    Een tekst die uit één lange blok bestaat (bijvoorbeeld uitgelezen pdf's)
//    wordt op zinsgrenzen in alinea's verdeeld.
//
// Wat hier níet gebeurt: niets verzinnen of samenvatten. Alleen weglaten van
// duidelijke rommel en opdelen. Een regel wordt alleen verwijderd als hij kort
// is én exact bij een van de patronen past; zo gaat er geen echte tekst verloren.

"use strict";

const cheerio = require("cheerio");

const MIN_BRUIKBARE_TEKST_TEKENS = 100;
const MIN_VOLLEDIG_TEKENS = 200;
const BLOB_VANAF_TEKENS = 900;
const ALINEA_DOEL_TEKENS = 420;
const BESTANDSTYPE = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(\?|#|$)/i;

// Zelfde lijst als in hulpmiddelen.js (daar niet geëxporteerd).
const ARTIKEL_WEG =
  'script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  ".breadcrumb, .breadcrumbs, .share, .social, .cookie, .cookies, #cookie, .related, .comments";

const ARTIKEL_INHOUD_SELECTORS = [
  ".text-content-section",
  ".aandachtstekst__tekst",
  ".entry-content",
  ".post-content",
  ".article-content",
  ".article-body",
  ".node__content",
  ".content-main",
  "article",
  '[role="main"]',
  "main",
  "#content",
  ".content",
];

const PAGINA_SELECTORS = ["main", '[role="main"]', "#content", ".content", "body"];

const BLOK = "p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, div, section, article, ul, ol, table, dd, dt, figcaption, pre";

function spatiesWeg(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}

function metTijdslimiet(belofte, ms, melding) {
  belofte.catch(() => {});
  let timer;
  const limiet = new Promise((_, afwijzen) => {
    timer = setTimeout(() => afwijzen(new Error(melding)), ms);
  });
  return Promise.race([belofte, limiet]).finally(() => clearTimeout(timer));
}

// Alle regels (alinea's) van één element, in leesvolgorde.
function regelsVanElement($, el) {
  const $el = $(el);
  // Eerst de witruimte in de HTML-bron zelf gelijkmaken, anders breekt een
  // zin die in de bron over twee regels staat midden in de alinea af.
  $el
    .find("*")
    .addBack()
    .contents()
    .each((_, n) => {
      if (n.type === "text") n.data = n.data.replace(/\s+/g, " ");
    });
  $el.find("br").replaceWith("\n");
  $el.find("li").each((_, li) => {
    $(li).prepend("• ");
  });
  $el.find("td, th").each((_, c) => {
    $(c).append(" ");
  });
  $el.find(BLOK).each((_, e) => {
    $(e).prepend("\n");
    $(e).append("\n");
  });
  return $el
    .text()
    .split(/\n+/)
    .map(spatiesWeg)
    .filter(Boolean);
}

function kapAfOpAlinea(regels, maxTekens) {
  if (!maxTekens) return regels;
  const uit = [];
  let totaal = 0;
  for (const r of regels) {
    if (totaal + r.length > maxTekens && uit.length) break;
    uit.push(r.length > maxTekens ? r.slice(0, maxTekens) : r);
    totaal += r.length + 2;
  }
  return uit;
}

/**
 * Haalt de artikeltekst uit HTML met alinea's behouden.
 * @returns {{tekst: string, methode: "artikel"} | null}
 */
function haalAlineaTekstUitHtml(html, opties = {}) {
  if (!html || String(html).startsWith("%PDF-")) return null;
  const $ = cheerio.load(html);

  const metaTeksten = [$('meta[property="og:description"]').attr("content"), $('meta[name="description"]').attr("content")]
    .map(spatiesWeg)
    .sort((a, b) => b.length - a.length);

  $(ARTIKEL_WEG).remove();

  const kandidaten = [];
  if (opties.detailSelector && typeof opties.detailSelector === "string" && opties.detailSelector.trim()) {
    kandidaten.push(opties.detailSelector.trim());
  }
  kandidaten.push(...ARTIKEL_INHOUD_SELECTORS);

  let beste = null;
  for (const selector of kandidaten) {
    let langste = 0;
    let element = null;
    try {
      $(selector).each((_, el) => {
        const lengte = spatiesWeg($(el).text()).length;
        if (lengte > langste) {
          langste = lengte;
          element = el;
        }
      });
    } catch {
      continue;
    }
    if (element && langste >= MIN_BRUIKBARE_TEKST_TEKENS) {
      beste = element;
      break;
    }
  }

  let regels = [];
  if (beste) regels = regelsVanElement($, beste);
  else if (metaTeksten[0] && metaTeksten[0].length >= MIN_BRUIKBARE_TEKST_TEKENS) regels = [metaTeksten[0]];
  if (!regels.length) return null;

  const schoon = schoonAlineas(regels.join("\n\n"), { titel: opties.titel });
  if (!schoon.tekst) return null;
  const regelsNa = kapAfOpAlinea(schoon.tekst.split("\n\n"), opties.maxTekens);
  return { tekst: regelsNa.join("\n\n"), methode: "artikel" };
}

/**
 * Reservemethode voor pagina's waar de gewone herkenning niets vindt
 * (bijvoorbeeld een iBabs-agendapagina): hoofdinhoud of anders de hele pagina.
 * @returns {string} tekst met alinea's, of ""
 */
function haalPaginaTekstMetAlineas(html, maxTekens) {
  if (!html || String(html).startsWith("%PDF-")) return "";
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select").remove();
  let beste = null;
  let besteLengte = 0;
  for (const sel of PAGINA_SELECTORS) {
    const el = $(sel).first();
    if (!el.length) continue;
    const lengte = spatiesWeg(el.text()).length;
    if (lengte > besteLengte && (lengte >= MIN_VOLLEDIG_TEKENS || sel === "body")) {
      beste = el.get(0);
      besteLengte = lengte;
      if (lengte >= MIN_VOLLEDIG_TEKENS) break;
    }
  }
  if (!beste) return "";
  const schoon = schoonAlineas(regelsVanElement($, beste).join("\n\n"));
  return kapAfOpAlinea(schoon.tekst.split("\n\n"), maxTekens).join("\n\n");
}

/**
 * Zoals haalArtikelTekst uit hulpmiddelen.js, maar met alinea's. Lukt dat niet,
 * dan valt hij terug op de bestaande methode, zodat er nooit minder tekst
 * binnenkomt dan voorheen.
 */
async function haalArtikelTekstMetAlineas(url, opties = {}) {
  const { haalOp, haalArtikelTekst } = require("./hulpmiddelen");
  if (!url || BESTANDSTYPE.test(url)) return null;
  if (/rechtspraak\.nl\/(?:uitspraak|inziendocument)\?/.test(url)) return haalArtikelTekst(url, opties);

  const html = await metTijdslimiet(
    haalOp(url, 2, { stil: true, timeoutMs: 30_000 }),
    90_000,
    `timeout na 90s bij het ophalen van ${url}`
  );
  const uit = haalAlineaTekstUitHtml(html, opties);
  if (uit && uit.tekst) return uit;
  return haalArtikelTekst(url, opties);
}

// ---------------------------------------------------------------------------
// Opschonen
// ---------------------------------------------------------------------------

// Hele regel (zonder punt of dubbele punt aan het eind) is alleen een knop of label.
const KNOP_REGEL =
  /^(delen|deel|deel dit|print|menu|sluiten|reageer|reageren|reacties|reactie plaatsen|advertentie|nieuwsbrief|terug|vorige|volgende|lees meer|lees verder|bekijk meer|meer nieuws|gerelateerd|gerelateerde artikelen|meest gelezen|tags|trefwoorden|onderwerpen)$/i;

// Begin van een korte doorverwijzing of oproep.
const DOORVERWIJZING_BEGIN =
  /^(lees ook|zie ook|ook interessant|volg ons|volg de orkaan|deel dit artikel|deel dit bericht|meld je aan voor de nieuwsbrief|schrijf je in voor|abonneer je|download de app)\b/i;

// Alleen een fotobijschrift of -credit.
const FOTO_REGEL = /^(foto|foto's|beeld|fotografie|afbeelding)\s*[:/]/i;

// Korte metaregels van de pagina zelf (geen onderdeel van de tekst).
const META_REGEL =
  /^((publicatiedatum|laatst gewijzigd):.{0,60}|\d+ reacties?|delen op:?|om te kunnen reageren moet u eerst inloggen\.?)$/i;

// Bronrommel aan het begin of eind van een tekst die al aan elkaar geplakt is
// (zoals de oudere teksten uit het archief, of pdf-tekst). Alleen patronen die
// in de echte data voorkomen; elk patroon is stevig verankerd.
const BRON_RANDEN = [
  /^Vorige pagina\s*[·|>-]?\s*/i, // kalender van Zaanstad
  /^Publicatiedatum:[\s\S]{1,70}?\sLaatst gewijzigd:[\s\S]{1,70}?\s\d+ reacties?\s*/i, // provincie Noord-Holland
  /^Permalink Printen Permanente link Naar de actuele versie van de regeling \S+ Naar de door u bekeken versie \S+\s*/i, // regelgeving
  /\s*Delen op:?(\s+Deel dit bericht op \S+)+(\s+Om te kunnen reageren moet u eerst inloggen\.?)?\s*$/i, // provincie Noord-Holland
];

const AFKORTING_EIND = /\b(mr|dr|drs|ir|ing|prof|st|nr|bv|nv|jhr|mevr|dhr|bijv|enz|ca|vs|etc)\.$/i;

function normaal(t) {
  return spatiesWeg(t).toLowerCase().replace(/[^a-z0-9à-ÿ ]/g, "").trim();
}

function isRommelRegel(regel) {
  const r = regel.trim();
  if (!r) return true;
  const zonderLeesteken = r.replace(/[:.\s]+$/, "");
  if (r.length <= 40 && KNOP_REGEL.test(zonderLeesteken)) return true;
  if (r.length <= 120 && DOORVERWIJZING_BEGIN.test(r)) return true;
  if (r.length <= 100 && FOTO_REGEL.test(r)) return true;
  if (r.length <= 90 && META_REGEL.test(r)) return true;
  return false;
}

// Verdeelt één lange tekst op zinsgrenzen in alinea's van ongeveer ALINEA_DOEL_TEKENS.
function deelInAlineas(tekst) {
  const stukken = tekst.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ0-9"“‘'(])/);
  const zinnen = [];
  for (const stuk of stukken) {
    if (zinnen.length && AFKORTING_EIND.test(zinnen[zinnen.length - 1])) zinnen[zinnen.length - 1] += ` ${stuk}`;
    else zinnen.push(stuk);
  }
  const alineas = [];
  let huidig = "";
  for (const zin of zinnen) {
    huidig = huidig ? `${huidig} ${zin}` : zin;
    if (huidig.length >= ALINEA_DOEL_TEKENS) {
      alineas.push(huidig);
      huidig = "";
    }
  }
  if (huidig) {
    if (alineas.length && huidig.length < 120) alineas[alineas.length - 1] += ` ${huidig}`;
    else alineas.push(huidig);
  }
  return alineas;
}

/**
 * Maakt een tekst leesbaar: bronrommel en dubbele regels eruit, de titel niet
 * herhalen, en te lange regels op zinsgrenzen in alinea's verdelen.
 * @param {object} opties
 * @param {string} [opties.titel]    titel van het bericht (niet herhalen aan het begin)
 * @param {string} [opties.splitOp]  scheidingsteken waarop een bron zijn velden aan
 *                                   elkaar plakt (iBabs: " — "); wordt een nieuwe regel
 * @returns {{tekst: string, alineas: number, rommelRegels: number, herleid: boolean, titelWeg: boolean}}
 */
function schoonAlineas(tekst, { titel = "", splitOp = null } = {}) {
  let ruw = String(tekst || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[\u200b\ufeff]/g, "");

  let rommelRegels = 0;
  for (const patroon of BRON_RANDEN) {
    const na = ruw.replace(patroon, "");
    if (na !== ruw) {
      rommelRegels++;
      ruw = na;
    }
  }
  if (splitOp) ruw = ruw.split(splitOp).join("\n");

  let regels = ruw
    .split(/\n+/)
    .map(spatiesWeg)
    .filter(Boolean);

  const gefilterd = [];
  for (const r of regels) {
    if (isRommelRegel(r)) {
      rommelRegels++;
      continue;
    }
    if (gefilterd.length && normaal(gefilterd[gefilterd.length - 1]) === normaal(r)) continue;
    gefilterd.push(r);
  }
  regels = gefilterd;

  let titelWeg = false;
  const t = normaal(titel);
  if (t && t.length >= 4 && regels.length) {
    const eerste = normaal(regels[0]);
    if (eerste === t) {
      // Een regel die precies de titel is, mag ook bij een korte titel weg.
      regels = regels.slice(1);
      titelWeg = true;
    } else if (t.length >= 12 && eerste.startsWith(t) && regels[0].length > titel.length + 3) {
      // Een titel die vooraan een alinea plakt: alleen bij een lange titel, anders is het kans op onzin.
      regels[0] = regels[0].slice(titel.length).replace(/^[\s\-–—:.,;•·]+/, "").trim();
      titelWeg = true;
      if (!regels[0]) regels.shift();
    }
  }

  // Een regel die te lang is voor één alinea (uitgelezen pdf's, oudere teksten
  // zonder regeleinden) wordt op zinsgrenzen verdeeld.
  let herleid = false;
  const verdeeld = [];
  for (const r of regels) {
    if (r.length > BLOB_VANAF_TEKENS) {
      const delen = deelInAlineas(r);
      if (delen.length > 1) {
        verdeeld.push(...delen);
        herleid = true;
        continue;
      }
    }
    verdeeld.push(r);
  }
  regels = verdeeld;

  return { tekst: regels.join("\n\n"), alineas: regels.length, rommelRegels, herleid, titelWeg };
}

module.exports = {
  haalAlineaTekstUitHtml,
  haalPaginaTekstMetAlineas,
  haalArtikelTekstMetAlineas,
  schoonAlineas,
  deelInAlineas,
  isRommelRegel,
};
