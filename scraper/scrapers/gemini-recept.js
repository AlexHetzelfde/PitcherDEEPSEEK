// scrapers/gemini-recept.js
//
// Generieke scraper voor bronnen die zijn toegevoegd via voeg-bron-toe.js.
// Gebruikt het eenmalig door Gemini gegenereerde "recept" (CSS-selectors,
// opgeslagen in bronnen.js bij bron.selectors) om dagelijks te scrapen —
// puur met cheerio, geen Gemini-aanroep per dag nodig.
//
// Sinds Deel B: leesItem haalt ook de foto op, via fotoSelector (als Gemini
// die heeft gegeven) met fallback naar de eerste <img> in het item. Dat werkt
// naast de tekststap in index.js: heeft de scraper al een foto, dan hoeft de
// tekststap de pagina niet meer op te halen voor de foto.

const { haalDatumUitTekst, leesDatumEnEinde, volgPaginas, haalFotoUitItem } = require("../hulpmiddelen");

/**
 * Zoekt een element BINNEN een item, maar ook het item zelf. cheerio's find()
 * kijkt alleen naar afstammelingen, dus een selector die het item zelf
 * beschrijft (bijvoorbeeld "a.kaart" als de hele kaart een link is) werd
 * nooit gevonden.
 */
function vindInItem($, el, selector) {
  if (!selector) return $();
  const binnen = $(el).find(selector).first();
  if (binnen.length) return binnen;
  return $(el).is(selector) ? $(el) : binnen;
}

function bruikbareHref(href) {
  return href && !href.startsWith("#") && !/^(javascript|mailto|tel):/i.test(href) ? href : null;
}

/**
 * Leest titel, link, datumtekst, samenvatting en foto uit één item. Wordt
 * door de scraper EN door de diagnose in gemini-recept-lus.js gebruikt,
 * zodat wat Gemini te horen krijgt ("de selector matchte 12 elementen, 0
 * hadden een link") altijd hetzelfde is als wat de scraper werkelijk doet.
 *
 * De link wordt in deze volgorde gezocht, en de eerste die bestaat wint:
 *   1. linkSelector, binnen het item (of het item zelf)
 *   2. het titel-element zelf, of de eerste link daarbinnen, of de link eromheen
 *   3. het item zelf als dat een <a> is, of de link eromheen
 *   4. de eerste link binnen het item
 * Stap 2 tot 4 vangen de gangbare variant op waarbij een hele kaart één
 * aanklikbare <a> is (zoals bij evenementenagenda's): daar is het item zelf de
 * link, en "self" of "a" als linkSelector vond die eerder niet.
 *
 * De foto komt uit fotoSelector (relatief aan het item) of, als die er niet
 * is, uit de eerste <img> binnen het item. De url wordt absoluut gemaakt
 * tegen paginaUrl (optioneel — alleen als de scraper hem heeft).
 */
function leesItem($, el, selectors, paginaUrl) {
  const { titelSelector, linkSelector, datumSelector, datumAttribuut, samenvattingSelector, fotoSelector, fotoAttribuut } = selectors;

  const titelEl = titelSelector ? vindInItem($, el, titelSelector) : $(el);
  const titel = titelEl.text().replace(/\s+/g, " ").trim();

  const kandidaten = [];
  if (linkSelector && linkSelector !== "self" && linkSelector !== "item") {
    kandidaten.push(vindInItem($, el, linkSelector).attr("href"));
  }
  kandidaten.push(titelEl.is("a") ? titelEl.attr("href") : null);
  kandidaten.push(titelEl.find("a[href]").first().attr("href"));
  kandidaten.push(titelEl.closest("a[href]").attr("href"));
  kandidaten.push($(el).is("a") ? $(el).attr("href") : null);
  kandidaten.push($(el).closest("a[href]").attr("href"));
  kandidaten.push($(el).find("a[href]").first().attr("href"));
  const link = kandidaten.map(bruikbareHref).find(Boolean) || null;

  let datumTekst = null;
  if (datumSelector) {
    const datumEl = vindInItem($, el, datumSelector);
    datumTekst = datumAttribuut ? datumEl.attr(datumAttribuut) : datumEl.text().replace(/\s+/g, " ").trim();
  }

  // Optioneel: de korte tekst of intro die de lijst bij het bericht toont.
  let samenvatting = "";
  if (samenvattingSelector) {
    samenvatting = vindInItem($, el, samenvattingSelector).text().replace(/\s+/g, " ").trim().slice(0, 600);
  }

  // Foto: via fotoSelector als Gemini die heeft gegeven, anders via de
  // ingebouwde fallback (eerste <img> in het item).
  const foto = haalFotoUitItem($, el, fotoSelector || null, fotoAttribuut || null, paginaUrl);

  return { titel, link, datumTekst, samenvatting, foto };
}

/** Leest de berichten van één lijstpagina (al geladen als cheerio-document). */
function leesPagina($, bron, paginaUrl) {
  const berichten = [];
  $(bron.selectors.itemSelector).each((_, el) => {
    const { titel, link, datumTekst, samenvatting, foto } = leesItem($, el, bron.selectors, paginaUrl);
    if (!titel || !link) return;

    // Val terug op de titel/item-tekst zelf als er geen los datum-element is
    // (of dat niets opleverde) — sommige sites (zoals de Zaanstad-
    // hoorzittingen) hebben de datum in de titeltekst gebakken in plaats van
    // in een apart element.
    //
    // Bij agenda-bronnen (bron.soort === "agenda") staan datums vaak zonder
    // jaar ("30 sep"); dan wordt het jaar afgeleid, en kijken we als laatste
    // redmiddel ook in de url zelf (sommige agenda's zetten de datum in het
    // pad, zoals /agenda/2026-09-29-lezing/).
    const agenda = bron.soort === "agenda";
    const opties = { zonderJaar: agenda };
    const nieuweUrl = new URL(link, paginaUrl).toString();
    //
    // Bij een agenda kan de datum een bereik zijn ("30 sep 11 okt"): dan
    // bewaren we ook de eindDatum (zie binnenAgendaVenster in hulpmiddelen.js).
    const gevonden = leesDatumEnEinde([[datumTekst, "streng"], [titel, "zoek"], [$(el).text(), "zoek"]], opties);
    const gepubliceerdOp = gevonden.start || (agenda ? haalDatumUitTekst(nieuweUrl) : null);
    const eindDatum = gevonden.start ? gevonden.eind : null;

    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url: nieuweUrl,
      samenvatting, // leeg als er geen samenvattingSelector is; de tekststap in index.js vult dan aan
      ...(foto ? { foto } : {}),
      gepubliceerdOp,
      ...(eindDatum ? { eindDatum } : {}),
      opgehaaldOp: new Date().toISOString(),
    });
  });

  return berichten;
}

async function scrapeGeminiRecept(bron) {
  if (!bron.selectors) {
    console.error(`[${bron.id}] Geen 'selectors' gevonden in bronnen.js voor dit gemini-recept-type — bron overgeslagen.`);
    return [];
  }

  // De eerste pagina plus de vervolgpagina's (zie volgPaginas in hulpmiddelen.js).
  const { berichten } = await volgPaginas(bron, ($, paginaUrl) => leesPagina($, bron, paginaUrl));

  const zonderDatum = berichten.filter((b) => !b.gepubliceerdOp).length;
  if (zonderDatum > 0) {
    console.warn(`[${bron.id}] ${zonderDatum} van ${berichten.length} berichten (gemini-recept) hadden geen herkenbare datum.`);
  }
  const zonderFoto = berichten.filter((b) => !b.foto).length;
  if (zonderFoto === berichten.length && berichten.length > 0) {
    console.warn(`[${bron.id}] Geen enkel bericht heeft een foto in de lijst; de tekststap in index.js probeert het nog via de berichtpagina's.`);
  }

  return berichten;
}

module.exports = { scrapeGeminiRecept, leesItem, leesPagina };
