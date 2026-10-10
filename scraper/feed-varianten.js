// feed-varianten.js
//
// Eén centrale lijst met ALLE bekende plekken waar een RSS/Atom-feed kan
// staan. Wordt gebruikt door:
//   - bron-ontdekking.js             (bij het toevoegen van een nieuwe bron)
//   - scrapers/wordpress-html.js     (dagelijkse run, WordPress-fallback)
//   - scrapers/generieke-lijst.js    (dagelijkse run, HTML-lijstpagina's)
//
// Reden: voorheen had elk van die drie plekken zijn eigen (korte) lijstje,
// waardoor een site die zijn feed op een minder voor de hand liggende plek
// heeft staan 's nachts niet gevonden werd. Nu is er één lijst, overal
// gelijk. De duur van de run maakt niet uit; grondigheid wel.
//
// Volgorde is belangrijk: hoe eerder in de lijst, hoe eerder geprobeerd.
//   1. Wat de pagina zelf zegt (<link rel="alternate"> in de HTML).
//   2. Alle standaardpaden, eerst op de pagina zelf, dan op de hoofdsite.
//   3. Query-varianten (?feed=rss2, ?feed=rss, ?feed=atom), idem.
// De aanroeper probeert ze één voor één en stopt bij de eerste die werkt.

const STANDAARD_PADEN = [
  // WordPress
  "feed/",
  "feed",
  "feed/rss/",
  "feed/atom/",
  // Basis RSS/Atom
  "rss",
  "rss/",
  "rss.xml",
  "atom",
  "atom.xml",
  "feed.xml",
  "feed.atom",
  // Hugo, Jekyll, statische generators
  "index.xml",
  // Subpaden voor nieuws-secties
  "blog/feed/",
  "news/feed/",
  "nieuws/feed/",
  "blog/rss/",
  "news/rss/",
  // Blogger
  "feeds/posts/default",
];

const QUERY_VARIANTEN = ["feed=rss2", "feed=rss", "feed=atom"];

/** Plakt een pad aan een basis-url, zonder dubbele slashes. */
function bouwPadKandidaat(basis, pad) {
  const basisZonderSlash = basis.replace(/\/+$/, "");
  const padZonderSlash = pad.replace(/^\/+/, "");
  return `${basisZonderSlash}/${padZonderSlash}`;
}

/** Zet een query-string op een basis-url (bestaande query wordt vervangen). */
function bouwQueryKandidaat(basisUrl, query) {
  try {
    const u = new URL(basisUrl);
    u.search = query;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Bouwt de volledige kandidatenlijst voor één pagina. De $ (cheerio) is
 * optioneel: met $ worden ook de <link>-tags uit de pagina gelezen, zonder $
 * alleen de standaardpaden.
 *
 * Geeft een array van urls, ontdubbeld op de tekst vóór het eerste #.
 */
function feedKandidaten(url, $) {
  const uit = [];
  const gezien = new Set();
  const voegToe = (kandidaat) => {
    if (!kandidaat) return;
    const zonderFragment = kandidaat.split("#")[0];
    if (gezien.has(zonderFragment)) return;
    gezien.add(zonderFragment);
    uit.push(kandidaat);
  };

  // 1. Wat de pagina zelf aangeeft via <link rel="alternate">.
  if ($) {
    $('link[rel~="alternate"]').each((_, el) => {
      const type = $(el).attr("type");
      const href = $(el).attr("href");
      if (!href || !type) return;
      if (!/rss|atom|json/i.test(type)) return;
      try {
        voegToe(new URL(href, url).toString());
      } catch {
        /* ongeldige href overslaan */
      }
    });
  }

  // 2 en 3. Standaardpaden en query-varianten, op de pagina en op de origin.
  const paginaBasis = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    /* ongeldige url: alleen de paginaBasis-varianten */
  }

  for (const pad of STANDAARD_PADEN) {
    voegToe(bouwPadKandidaat(paginaBasis, pad));
    if (origin) voegToe(bouwPadKandidaat(origin, pad));
  }
  for (const query of QUERY_VARIANTEN) {
    voegToe(bouwQueryKandidaat(paginaBasis, query));
    if (origin) voegToe(bouwQueryKandidaat(origin, query));
  }

  return uit;
}

module.exports = { feedKandidaten, STANDAARD_PADEN, QUERY_VARIANTEN };
