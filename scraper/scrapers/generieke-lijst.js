// scrapers/generieke-lijst.js
//
// Voor institutionele/overheidssites (musea, waterschap, provincie, scholen)
// die geen WordPress draaien en dus geen voorspelbare /feed/ hebben. We
// proberen eerst alsnog een RSS/Atom-feed te vinden — niet alleen via een
// <link>-tag in de <head>, maar ook via de uitgebreide lijst standaardpaden
// uit feed-varianten.js (feed/, rss, index.xml, blog/feed/, ?feed=rss2,
// enzovoort). Lukt dat niet, dan scrapen we de HTML met een bredere set
// patronen dan de WordPress-scraper.
//
// Sinds de "feed-retry"-ronde: de eerste 5 kandidaten (de meest waarschijnlijke)
// krijgen 2 pogingen in plaats van 1. Reden: een enkele time-out op een goede
// feed-URL liet de scraper eerder doorgaan naar 40 andere kandidaten (die
// allemaal 404 zijn) en zo "geen feed" melden, terwijl de juiste feed gewoon
// even niet reageerde. Ook wordt nu gelogd wat een feed-kandidaat mankeert,
// behalve bij een gewone 404 ("niet gevonden").
//
// Sinds Deel B: de HTML-scrape probeert per item ook een foto te vinden.

const cheerio = require("cheerio");
const { haalOp, parseerRssTekst, oorzaakTekst, leesDatumEnEinde, volgPaginas, haalFotoUitItem } = require("../hulpmiddelen");
const { feedKandidaten } = require("../feed-varianten");

// Hoeveel van de eerste feed-kandidaten een tweede kans krijgen. Daarna
// proberen we de rest met één poging (die zijn bijna altijd 404; daar is een
// retry zonde van de tijd).
const MAX_KANDIDATEN_MET_RETRY = 5;

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
  try {
    const html = await haalOp(bron.url);
    const $ = cheerio.load(html);

    // Stap 1: alle bekende feed-plekken proberen. De eerste 5 krijgen 2
    // pogingen, de rest 1. De eerste die een geldige feed teruggeeft wint.
    const kandidaten = feedKandidaten(bron.url, $);
    for (let i = 0; i < kandidaten.length; i++) {
      const feedUrl = kandidaten[i];
      const pogingen = i < MAX_KANDIDATEN_MET_RETRY ? 2 : 1;
      try {
        const feedTekst = await haalOp(feedUrl, pogingen, { stil: true });
        // Soft 404-bescherming: HTML terugkrijgen waar een feed verwacht werd.
        if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(feedTekst.slice(0, 2000))) continue;
        const items = await parseerRssTekst(feedTekst, bron);
        if (items.length > 0) {
          console.log(`[${bron.id}] Feed gevonden en gebruikt (${feedUrl}), ${items.length} bericht(en).`);
          return items;
        }
      } catch (fout) {
        // Een 404 betekent: deze kandidaat bestaat niet, dat is normaal. Iets
        // anders (time-out, 403, 5xx) is wél de moeite om te melden, want dat
        // kan verklaren waarom een werkende feed deze run niet gevonden werd.
        if (!/HTTP 404/.test(fout.message)) {
          console.log(`[${bron.id}] Feed-kandidaat ${feedUrl} faalde: ${fout.message}`);
        }
      }
    }

    // Stap 2: HTML-scrape met de bredere patronenset, over alle pagina's.
    console.log(`[${bron.id}] Geen bruikbare feed in ${kandidaten.length} varianten, generieke HTML-scrape gebruikt.`);
    return await scrapeHtml($, bron, html);
  } catch (fout) {
    console.error(`[${bron.id}] Generieke lijst-scraper mislukt: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }
}

function probeerGeneriekePatronen($, bron, opties = {}) {
  const datumOpties = { zonderJaar: bron.soort === "agenda" };
  const minimum = opties.minimum ?? 3;
  const paginaUrl = opties.paginaUrl || bron.url;
  for (const selector of opties.selector ? [opties.selector] : ITEM_SELECTORS) {
    const berichten = [];
    $(selector).each((_, el) => {
      const titelEl = $(el).find("h1, h2, h3, h4").first();
      const titel = titelEl.text().trim();
      const link = titelEl.find("a").attr("href") || $(el).find("a").first().attr("href");
      if (!titel || !link || titel.length < 8) return;

      const datumTekst =
        $(el).find("time").attr("datetime") ||
        $(el).find("time").text().trim() ||
        ($(el).text().match(/\d{1,2}[\s\-\/]\w+[\s\-\/]\d{4}/) || [])[0];

      const datum = leesDatumEnEinde([[datumTekst, "streng"], [titel, "zoek"], [$(el).text(), "zoek"]], datumOpties);

      const foto = haalFotoUitItem($, el, null, null, paginaUrl);

      berichten.push({
        bronId: bron.id,
        bronNaam: bron.naam,
        categorie: bron.categorie,
        titel,
        url: new URL(link, paginaUrl).toString(),
        samenvatting: $(el).find("p").first().text().trim().slice(0, 400),
        ...(foto ? { foto } : {}),
        gepubliceerdOp: datum.start,
        ...(datum.start && datum.eind ? { eindDatum: datum.eind } : {}),
        opgehaaldOp: new Date().toISOString(),
      });
    });

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
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (selector "${resultaat.selector}") hadden geen herkenbare datum.`);
  }
  const zonderFoto = berichten.filter((b) => !b.foto).length;
  if (zonderFoto === berichten.length && berichten.length > 0) {
    console.warn(`[${bron.id}] Geen enkel bericht heeft een foto in de lijst; de tekststap probeert het nog via de berichtpagina's.`);
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
