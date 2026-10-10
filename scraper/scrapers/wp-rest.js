// scrapers/wp-rest.js
//
// Haalt berichten op via de WordPress REST API, bijvoorbeeld
//   https://voorbeeld.nl/wp-json/wp/v2/posts?per_page=20&orderby=date&order=desc
// of, voor een eigen berichttype zoals een evenementenagenda,
//   https://voorbeeld.nl/wp-json/wp/v2/agenda?per_page=20&orderby=date&order=desc
//
// Waarom dit bestaat: veel WordPress-sites hebben een lege of onbruikbare
// RSS-feed (de algemene /feed/ toont alleen gewone berichten), terwijl hun
// agenda of nieuws als eigen berichttype wel via de REST API beschikbaar is.
// JSON is stabieler dan HTML-selectors: een theme-update breekt dit niet.
//
// De datum is de publicatiedatum van het bericht op de site (date_gmt), dus
// niet de datum van een evenement.
//
// Sinds Deel B: de uitgelichte afbeelding van elk bericht wordt opgehaald via
// _embed=wp:featuredmedia. Werkt de site zonder _embed (of blokkeert die de
// query), dan blijft het foto-veld leeg en vult de tekststap in index.js het
// later aan via de og:image op de berichtpagina.

const cheerio = require("cheerio");
const { haalOp } = require("../hulpmiddelen");

/** Haalt platte tekst uit HTML zoals WordPress die in title.rendered en excerpt.rendered levert (met entiteiten als &amp;). */
function platteTekst(html) {
  if (!html) return "";
  return cheerio.load(`<div>${html}</div>`).text().replace(/\s+/g, " ").trim();
}

/**
 * Voegt _embed=wp:featuredmedia toe aan de REST-url, zodat de uitgelichte
 * afbeelding in het antwoord meekomt. Bestaande query-parameters blijven
 * staan; heeft de url al een _embed, dan laten we hem ongemoeid.
 */
function metEmbed(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("_embed")) u.searchParams.set("_embed", "wp:featuredmedia");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Foto uit één REST-item halen. WordPress levert de uitgelichte media in
 * _embedded['wp:featuredmedia'][0]. Soms is dat een fout-object
 * ({ code: "rest_post_invalid_id" }) — dan gewoon null terug.
 * We proberen eerst source_url (het volledige origineel), dan de grootste
 * variant in media_details.sizes.full.
 */
function haalFotoUitWpItem(item) {
  const embedded = item._embedded && item._embedded["wp:featuredmedia"];
  if (!Array.isArray(embedded) || embedded.length === 0) return null;
  const media = embedded[0];
  if (!media || media.code) return null;
  const uitSizes = media.media_details && media.media_details.sizes && media.media_details.sizes.full && media.media_details.sizes.full.source_url;
  return media.source_url || uitSizes || null;
}

async function scrapeWpRest(bron) {
  const tekst = await haalOp(metEmbed(bron.url));
  let data;
  try {
    data = JSON.parse(tekst);
  } catch {
    throw new Error(`Geen geldige JSON van de WordPress REST API op ${bron.url}`);
  }
  if (!Array.isArray(data)) {
    const melding = data && data.message ? `: ${data.message}` : "";
    throw new Error(`De WordPress REST API gaf geen lijst terug${melding}`);
  }

  return data
    .map((item) => {
      // date_gmt heeft geen tijdzone-aanduiding ("2026-09-29T10:00:00"), maar is wel UTC.
      const datumGmt = item.date_gmt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(item.date_gmt) ? `${item.date_gmt}Z` : item.date_gmt;
      const datum = new Date(datumGmt || item.date || "");
      const foto = haalFotoUitWpItem(item);
      return {
        bronId: bron.id,
        bronNaam: bron.naam,
        categorie: bron.categorie,
        titel: platteTekst(item.title && item.title.rendered),
        url: item.link || "",
        samenvatting: platteTekst(item.excerpt && item.excerpt.rendered).slice(0, 600),
        ...(foto ? { foto } : {}),
        gepubliceerdOp: isNaN(datum.getTime()) ? null : datum.toISOString(),
        opgehaaldOp: new Date().toISOString(),
      };
    })
    .filter((b) => b.titel && b.url);
}

module.exports = { scrapeWpRest, platteTekst };
