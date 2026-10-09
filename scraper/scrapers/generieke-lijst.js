// scrapers/generieke-lijst.js
//
// Voor institutionele/overheidssites (musea, waterschap, provincie, scholen)
// die geen WordPress draaien en dus geen voorspelbare /feed/ hebben. We
// proberen eerst alsnog een RSS/Atom-feed te vinden via een <link>-tag in de
// <head> — sommige custom CMS'en hebben die wel, ook zonder dat de URL
// voorspelbaar is. Lukt dat niet, dan scrapen we de HTML met een bredere set
// patronen dan de WordPress-scraper, omdat deze sites onderling veel meer
// van elkaar verschillen.
//
// LET OP: dit is bewust een brede, algemene aanpak — geen scraper die precies
// op de HTML van elke individuele site is afgestemd (dat vereist inzage in
// de broncode per site, die we hier niet hebben kunnen inspecteren). Voor
// sommige bronnen zal deze aanpak in één keer goed werken, voor andere zal
// er na de eerste run bijgesteld moeten worden — check de bericht-aantallen
// in de logs per bron; 0 berichten van een bron die duidelijk wel nieuws
// heeft is het signaal om deze scraper voor die specifieke bron te verfijnen.

const cheerio = require("cheerio");
const { haalOp, parseerRssTekst, oorzaakTekst, haalDatumUitTekst, leesDatumEnEinde, volgPaginas } = require("../hulpmiddelen");

// Volgorde van kandidaat-selectors voor één nieuwsitem-blok, breed naar smal.
const ITEM_SELECTORS = [
  "article",
  ".news-item",
  ".nieuws-item",
  "li.nieuwsitem",
  ".card",
  ".teaser",
  ".list-item",
  "li",
];

async function scrapeGeneriekeLijst(bron) {
  // Stap 1: kijk of de pagina zelf naar een RSS/Atom-feed linkt.
  try {
    const html = await haalOp(bron.url);
    const $ = cheerio.load(html);
    const feedHref = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').attr("href");

    if (feedHref) {
      const feedUrl = new URL(feedHref, bron.url).toString();
      try {
        const feedTekst = await haalOp(feedUrl);
        const items = await parseerRssTekst(feedTekst, bron);
        if (items.length > 0) {
          console.log(`[${bron.id}] Feed gevonden en gebruikt (${feedUrl}), ${items.length} bericht(en).`);
          return items;
        }
      } catch (fout) {
        console.warn(`[${bron.id}] Gevonden feed (${feedUrl}) kon niet geladen worden: ${fout.message}${oorzaakTekst(fout)}.`);
      }
    }

    // Stap 2: HTML-scrape met de bredere patronenset, over alle pagina's (zie volgPaginas).
    console.log(`[${bron.id}] Geen feed gevonden/bruikbaar, generieke HTML-scrape gebruikt.`);
    return await scrapeHtml($, bron, html);
  } catch (fout) {
    console.error(`[${bron.id}] Generieke lijst-scraper mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }
}

/**
 * Probeert de vaste lijst kandidaat-selectors, breed naar smal, tegen een
 * al-geladen cheerio-document. Puur functie — geen logging, geen fetch —
 * zodat dit ook door voeg-bron-toe.js hergebruikt kan worden om dit gratis
 * te proberen vóórdat Gemini wordt ingeschakeld. Eén implementatie, niet
 * twee die uit elkaar kunnen lopen (zoals eerder het geval was).
 *
 * Geeft { selector, berichten } terug zodra een selector minstens 3
 * bruikbare berichten oplevert, anders null.
 *
 * opties (voor vervolgpagina's, zie scrapeHtml): { selector } probeert alleen
 * die ene selector, en { minimum } vervangt de ondergrens van 3 berichten (de
 * laatste pagina van een lijst heeft vaak maar een paar berichten).
 */
function probeerGeneriekePatronen($, bron, opties = {}) {
  // Agenda-bronnen tonen datums vaak zonder jaar ("30 sep"); zie haalDatumZonderJaar in hulpmiddelen.js.
  const datumOpties = { zonderJaar: bron.soort === "agenda" };
  const minimum = opties.minimum ?? 3;
  const paginaUrl = opties.paginaUrl || bron.url;
  for (const selector of opties.selector ? [opties.selector] : ITEM_SELECTORS) {
    const berichten = [];
    $(selector).each((_, el) => {
      const titelEl = $(el).find("h1, h2, h3, h4").first();
      const titel = titelEl.text().trim();
      const link = titelEl.find("a").attr("href") || $(el).find("a").first().attr("href");
      if (!titel || !link || titel.length < 8) return; // te korte "titels" zijn meestal menu-items, geen nieuws

      const datumTekst =
        $(el).find("time").attr("datetime") ||
        $(el).find("time").text().trim() ||
        ($(el).text().match(/\d{1,2}[\s\-\/]\w+[\s\-\/]\d{4}/) || [])[0];

      // Zelfde fallback als de andere scrapers: als er geen (bruikbaar)
      // datum-element is, kijk of de titel/item-tekst zelf een datum
      // bevat (zoals bij loket.zaanstad.nl). Bij een agenda kan dat een
      // bereik zijn, dan bewaren we ook de eindDatum.
      const datum = leesDatumEnEinde([[datumTekst, "streng"], [titel, "zoek"], [$(el).text(), "zoek"]], datumOpties);

      berichten.push({
        bronId: bron.id,
        bronNaam: bron.naam,
        categorie: bron.categorie,
        titel,
        url: new URL(link, paginaUrl).toString(),
        samenvatting: $(el).find("p").first().text().trim().slice(0, 400),
        gepubliceerdOp: datum.start,
        ...(datum.start && datum.eind ? { eindDatum: datum.eind } : {}),
        opgehaaldOp: new Date().toISOString(),
      });
    });

    // Zodra een selector minstens een paar bruikbare berichten oplevert,
    // gaan we daarvan uit — anders proberen we de volgende, bredere selector.
    if (berichten.length >= minimum) {
      return { selector, berichten: dedupliceerOpUrl(berichten) };
    }
  }
  return null;
}

async function scrapeHtml($, bron, eersteHtml) {
  const resultaat = probeerGeneriekePatronen($, bron);
  if (!resultaat) {
    console.warn(`[${bron.id}] Geen van de generieke patronen leverde berichten op — deze bron heeft waarschijnlijk maatwerk nodig.`);
    return [];
  }

  // Pagina 1 bepaalt welke selector werkt; de vervolgpagina's gebruiken diezelfde
  // selector (met een ondergrens van 1 bericht, voor een korte laatste pagina).
  const { berichten } = await volgPaginas(
    bron,
    ($pagina, paginaUrl, n) =>
      n === 1
        ? resultaat.berichten
        : (probeerGeneriekePatronen($pagina, bron, { selector: resultaat.selector, minimum: 1, paginaUrl }) || { berichten: [] }).berichten,
    { eersteHtml }
  );

  const zonderDatum = berichten.filter((b) => !b.gepubliceerdOp).length;
  if (zonderDatum > 0) {
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (selector "${resultaat.selector}") hadden geen herkenbare datum — die tellen nu mee als "te oud" bij de leeftijdsfilter.`);
  }
  return berichten;
}

function dedupliceerOpUrl(berichten) {
  const gezien = new Set();
  return berichten.filter((b) => {
    if (gezien.has(b.url)) return false;
    gezien.add(b.url);
    return true;
  });
}


module.exports = { scrapeGeneriekeLijst, probeerGeneriekePatronen };
