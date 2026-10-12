// scrapers/wordpress-html.js
//
// Scraapt een WordPress-nieuwsoverzichtspagina. WordPress-sites hebben bijna
// altijd ook een RSS-feed op /feed/ — die proberen we eerst, want dat is veel
// robuuster dan HTML-scrapen. Lukt dat niet, dan valt de functie terug op het
// scrapen van de HTML-lijst zelf.
//
// Sinds de "feed-retry"-ronde: de eerste 5 feed-kandidaten (uit de pagina zelf
// én de standaardpaden) krijgen 2 pogingen in plaats van 1. Zoals bij
// generieke-lijst: één time-out op een goede URL mag niet betekenen dat we
// "geen feed" melden en op HTML terugvallen.
//
// Sinds Deel B probeert de HTML-fallback per item ook een foto te vinden.

const cheerio = require("cheerio");
const { haalOp, parseerRssTekst, oorzaakTekst, volgPaginas, haalFotoUitItem } = require("../hulpmiddelen");
const { feedKandidaten } = require("../feed-varianten");

const MAX_KANDIDATEN_MET_RETRY = 5;

async function scrapeWordpress(bron) {
  let html;
  try {
    html = await haalOp(bron.url);
  } catch (fout) {
    console.error(`[${bron.id}] Kon de pagina niet ophalen: ${fout.message}${oorzaakTekst(fout)}`);
    return [];
  }
  const $ = cheerio.load(html);

  const kandidaten = feedKandidaten(bron.url, $);
  for (let i = 0; i < kandidaten.length; i++) {
    const feedUrl = kandidaten[i];
    const pogingen = i < MAX_KANDIDATEN_MET_RETRY ? 2 : 1;
    try {
      const feedTekst = await haalOp(feedUrl, pogingen, { stil: true });
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(feedTekst.slice(0, 2000))) continue;
      const items = await parseerRssTekst(feedTekst, bron);
      if (items.length > 0) {
        console.log(`[${bron.id}] RSS-feed gebruikt (${feedUrl}), ${items.length} bericht(en).`);
        return items;
      }
    } catch (fout) {
      if (!/HTTP 404/.test(fout.message)) {
        console.log(`[${bron.id}] Feed-kandidaat ${feedUrl} faalde: ${fout.message}`);
      }
    }
  }
  console.log(`[${bron.id}] Geen bruikbare feed in ${kandidaten.length} varianten, HTML-fallback gebruikt.`);

  const { berichten } = await volgPaginas(bron, ($pagina, paginaUrl) => leesWordpressPagina($pagina, bron, paginaUrl), { eersteHtml: html });

  const zonderDatum = berichten.filter((b) => !b.gepubliceerdOp).length;
  if (zonderDatum > 0) {
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (HTML-fallback) hadden geen herkenbare datum.`);
  }
  const zonderFoto = berichten.filter((b) => !b.foto).length;
  if (zonderFoto === berichten.length && berichten.length > 0) {
    console.warn(`[${bron.id}] Geen enkel bericht heeft een foto in de HTML-lijst; de tekststap probeert het nog via de berichtpagina's.`);
  }

  return berichten;
}

function leesWordpressPagina($, bron, paginaUrl) {
  const berichten = [];
  const samenvattingSelector = bron.selectors && bron.selectors.samenvattingSelector;
  const fotoSelector = bron.selectors && bron.selectors.fotoSelector;
  const fotoAttribuut = bron.selectors && bron.selectors.fotoAttribuut;
  const basisUrl = paginaUrl || bron.url;

  $("article, .post, .news-item").each((_, el) => {
    const titelEl = $(el).find("h1, h2, h3").first();
    const titel = titelEl.text().trim();
    const link = titelEl.find("a").attr("href") || $(el).find("a").first().attr("href");
    if (!titel || !link) return;

    const datumTekst = $(el).find("time").attr("datetime") || $(el).find("time").text().trim();
    const gepubliceerdOp = parseerDatum(datumTekst) || datumUitPermalink($, el);

    const foto = haalFotoUitItem($, el, fotoSelector || null, fotoAttribuut || null, basisUrl);

    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url: link,
      samenvatting: samenvattingSelector ? $(el).find(samenvattingSelector).first().text().replace(/\s+/g, " ").trim().slice(0, 600) : "",
      ...(foto ? { foto } : {}),
      gepubliceerdOp,
      opgehaaldOp: new Date().toISOString(),
    });
  });

  return berichten;
}

function datumUitPermalink($, el) {
  let gevonden = null;
  $(el)
    .find("a")
    .each((_, a) => {
      if (gevonden) return;
      const href = $(a).attr("href") || "";
      const match = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
      if (!match) return;
      const [, jaar, maand, dag] = match;
      const tijdTekst = $(a).attr("title") || "";
      const tijdMatch = tijdTekst.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
      let uur = 0;
      let minuut = 0;
      if (tijdMatch) {
        uur = Number(tijdMatch[1]) % 12;
        minuut = Number(tijdMatch[2]);
        if ((tijdMatch[3] || "").toLowerCase() === "pm") uur += 12;
      }
      const datum = new Date(Number(jaar), Number(maand) - 1, Number(dag), uur, minuut);
      if (!isNaN(datum.getTime())) gevonden = datum.toISOString();
    });
  return gevonden;
}

function parseerDatum(tekst) {
  if (!tekst) return null;
  const d = new Date(tekst);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { scrapeWordpress };
