// scraper-register.js
//
// Eén plek waar "bron.type" gekoppeld wordt aan de bijbehorende scraper-
// functie. Zowel index.js (de dagelijkse run), voeg-bron-toe.js (bij het
// toevoegen van een nieuwe bron) als valideer-bronnen.js (de check vóór elke
// commit) importeren dit bestand — nooit hun eigen kopie van deze lijst.
//
// Dit bestaat specifiek om de "onbekend brontype"-bug te voorkomen die op
// 2026-09-21 zaanstad-hoorzittingen een hele nacht liet overslaan: het
// scraper-type "gemini-recept" bestond wel in bronnen.js, maar niet in de
// (toen nog losse, alleen-in-index.js-levende) dispatch-tabel. Met één
// gedeeld register kan dat gat structureel niet meer ontstaan — er is nu nog
// maar één plaats om een nieuw scraper-type te registreren, en alles wat een
// type moet kennen leest van hier.
//
// Nieuw scraper-type toevoegen? Voeg het hier toe, op deze ene plek — niet
// los in index.js of voeg-bron-toe.js.

const { scrapeWordpress } = require("./scrapers/wordpress-html");
const { scrapeIbabs } = require("./scrapers/ibabs");
const { scrapeIbabsKalender } = require("./scrapers/ibabs-kalender");
const { scrapeIbabsDashboard } = require("./scrapers/ibabs-dashboard");
const { scrapeRss } = require("./scrapers/rss");
const { scrapeGeneriekeLijst } = require("./scrapers/generieke-lijst");
const { scrapeGeminiRecept } = require("./scrapers/gemini-recept");
const { scrapeWpRest } = require("./scrapers/wp-rest");
const { scrapeJsonLd } = require("./scrapers/json-ld");
const { scrapeJsonApi } = require("./scrapers/json-api");
const { scrapeMoties } = require("./scrapers/moties");
const { scrapeCamera } = require("./scrapers/camera");
const { scrapeTed } = require("./scrapers/ted");
const { scrapeTenderned } = require("./scrapers/tenderned");

const SCRAPER_PER_TYPE = {
  "wordpress-html": scrapeWordpress,
  ibabs: scrapeIbabs,
  "ibabs-kalender": scrapeIbabsKalender, // vergader- en bijeenkomstenkalender van een iBabs-publieksportaal
  "ibabs-dashboard": scrapeIbabsDashboard, // blok "Overzichten" op de startpagina van een iBabs-portaal
  rss: scrapeRss,
  "generieke-lijst": scrapeGeneriekeLijst,
  "gemini-recept": scrapeGeminiRecept,
  "wp-rest": scrapeWpRest, // WordPress REST API, ook voor eigen berichttypes (bv. een agenda)
  "json-ld": scrapeJsonLd, // schema.org-gegevens (Event/Article) uit de pagina zelf
  "json-api": scrapeJsonApi, // los JSON-endpoint, met veldkoppeling in bron.json
  camera: scrapeCamera, // cameratoezicht uit officielebekendmakingen.nl, met reeksen (alleen ZANP)
  ted: scrapeTed, // aanbestedingen van de gemeente uit TED, de Europese databank (alleen ZANP)
  tenderned: scrapeTenderned, // aanbestedingen uit TenderNed, ook nationaal en onder de drempel (alleen ZANP)
  moties: scrapeMoties, // moties met stemming en strekking uit het iBabs-rapport "Moties en amendementen" (alleen ZANP)
};

/** Geeft de scraper-functie voor een type, of undefined als die niet bestaat. */
function scraperVoorType(type) {
  return SCRAPER_PER_TYPE[type];
}

/** Geeft alle geldige/geregistreerde brontypes, voor foutmeldingen en validatie. */
function geldigeTypes() {
  return Object.keys(SCRAPER_PER_TYPE);
}

module.exports = { SCRAPER_PER_TYPE, scraperVoorType, geldigeTypes };
