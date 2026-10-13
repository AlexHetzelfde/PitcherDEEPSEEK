// bron-ontdekking.js
//
// Zoekt uit HOE een nieuwe bron het beste automatisch opgehaald kan worden,
// en bewijst dat het werkt voordat het als bron wordt teruggegeven.
//
// Sinds de "schone tekst"-ronde (2026-10-13): als de aanroeper een bestaande
// detailSelector meegeeft (bij het herstellen van een bron), wordt die aan de
// nieuwe bron-config toegevoegd. Zonder dat zou herstel-bronnen.js het veld
// uit een werkende bron wegpoetsen.
//
// Sinds de "directe feed"-ronde (2026-10-13): als de opgegeven URL zelf een
// RSS/Atom/RDF-feed is, wordt hij meteen als type "rss" getest en
// teruggegeven. Geen Gemini, geen HTML-analyse. Dat werkt voor
// voeg-bron-toe.js én herstel-bronnen.js, want allebei gebruiken ze
// ontdekBron().

const cheerio = require("cheerio");
const { haalOp, oorzaakTekst, startResponsCache, stopResponsCache } = require("./hulpmiddelen");
const { testBron, normaliseerUrl, voorbeeldRegels, SELECTOR_TYPES, MIN_DEKKING } = require("./bron-poort");
const { probeerGeneriekePatronen } = require("./scrapers/generieke-lijst");
const { feedKandidaten } = require("./feed-varianten");

const GEMINI_VERPLICHT_MELDING =
  "GEMINI_API_KEY ontbreekt. Een bron toevoegen of herstellen heeft Gemini altijd nodig: Gemini leest de hele pagina en geeft de lijst van berichten waartegen elke methode wordt gecontroleerd. Zet het secret GEMINI_API_KEY in de repo-instellingen (Settings > Secrets and variables > Actions).";

const MAX_KANDIDATEN_REST = 6;
const WP_NEGEER_TYPES = new Set([
  "attachment", "page", "nav_menu_item", "wp_block", "wp_template", "wp_template_part",
  "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face", "revision",
]);

/**
 * Is de opgegeven URL zelf een RSS/Atom/RDF-feed? Zo ja: haal hem op en
 * controleer of de eerste 2000 tekens een feed-root bevatten. Geen Gemini
 * nodig — de feed is zijn eigen referentie.
 */
async function isDirecteFeed(url) {
  try {
    const tekst = await haalOp(url, 1, { stil: true });
    return /<(rss|feed|rdf:RDF)[\s>]/i.test(tekst.slice(0, 2000));
  } catch {
    return false;
  }
}

function agendaAchtig(url) {
  try {
    const u = new URL(url);
    return /agenda|evenement|activiteit|kalender|uitagenda|\bevents?\b/i.test(`${u.hostname}${u.pathname}`);
  } catch {
    return false;
  }
}

function verzamelPaginaLinks($, paginaUrl) {
  const set = new Set();
  $("a[href]").each((_, el) => {
    const genormaliseerd = normaliseerUrl($(el).attr("href"), paginaUrl);
    if (genormaliseerd) set.add(genormaliseerd);
  });
  return set;
}

function soortVarianten(type, soortKeuze, url, geminiSoort) {
  if (soortKeuze === "agenda") return ["agenda"];
  if (soortKeuze === "nieuws") return [undefined];
  if (!SELECTOR_TYPES.includes(type)) return [undefined];
  return agendaAchtig(url) || geminiSoort === "agenda" ? ["agenda", undefined] : [undefined, "agenda"];
}

function noteer(verslag, log, stap, kandidaat, oordeel) {
  const label = `${stap}: ${kandidaat.type}${kandidaat.url ? ` ${kandidaat.url}` : ""}`;
  const uitkomst = oordeel.geslaagd ? (oordeel.twijfel ? "twijfel" : "geslaagd") : "afgekeurd";
  verslag.push({ stap, kandidaat: label, uitkomst, redenen: oordeel.redenen, waarschuwingen: oordeel.waarschuwingen, aantal: oordeel.aantal, tekst: oordeel.tekstTekst || null });
  if (oordeel.geslaagd) {
    log.log(`  ${oordeel.twijfel ? "?" : "✓"} ${label}: ${oordeel.aantal} bericht(en)${oordeel.tekstTekst ? `, ${oordeel.tekstTekst}` : ""}${oordeel.twijfel ? " (twijfel: hoort mogelijk niet bij deze pagina)" : ""}`);
    voorbeeldRegels(oordeel).forEach((r) => log.log(r));
    oordeel.waarschuwingen.forEach((w) => log.log(`    ⚠️  ${w}`));
  } else {
    log.log(`  ✗ ${label}${oordeel.tekstTekst ? ` (${oordeel.tekstTekst})` : ""}`);
    oordeel.redenen.forEach((r) => log.log(`      - ${r}`));
  }
}

const pauze = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeerTekst(url) {
  await pauze(150);
  try {
    return await haalOp(url, 1, { stil: true });
  } catch {
    return null;
  }
}

async function restKandidaten($, url) {
  const apiHref = $('link[rel="https://api.w.org/"]').attr("href");
  let apiRoot;
  try {
    apiRoot = new URL(apiHref || "/wp-json/", url).toString();
  } catch {
    return [];
  }
  if (!apiRoot.endsWith("/")) apiRoot += "/";
  if (/[?]/.test(apiRoot)) return [];

  const typesTekst = await probeerTekst(new URL("wp/v2/types", apiRoot).toString());
  let types = [];
  if (typesTekst) {
    try {
      const json = JSON.parse(typesTekst);
      types = Object.entries(json)
        .filter(([slug, t]) => t && t.rest_base && !WP_NEGEER_TYPES.has(slug))
        .map(([slug, t]) => ({ slug, restBase: t.rest_base }));
    } catch {
      /* geen JSON */
    }
  }
  if (types.length === 0 && !apiHref) return [];
  if (!types.some((t) => t.restBase === "posts")) types.push({ slug: "post", restBase: "posts" });

  const pad = new URL(url).pathname.toLowerCase();
  const rang = (t) => (pad.includes(t.slug.toLowerCase()) || pad.includes(t.restBase.toLowerCase()) ? 0 : t.slug === "post" ? 2 : 1);
  types.sort((a, b) => rang(a) - rang(b));

  return types.slice(0, MAX_KANDIDATEN_REST).map(
    (t) => new URL(`wp/v2/${t.restBase}?per_page=20&orderby=date&order=desc&_fields=date_gmt,date,link,title,excerpt`, apiRoot).toString()
  );
}

function bouwEindBron(basis, kandidaat, oordeel, soort, behoud = {}) {
  const bron = { id: basis.id, naam: basis.naam, categorie: basis.categorie, type: kandidaat.type, url: kandidaat.url };
  if (soort) bron.soort = soort;
  if (oordeel.rustig) bron.rustig = true;
  const detailSelector = kandidaat.detailSelector || behoud.detailSelector;
  if (detailSelector) bron.detailSelector = detailSelector;
  if (kandidaat.selectors) bron.selectors = kandidaat.selectors;
  if (kandidaat.paginering) bron.paginering = kandidaat.paginering;
  if (kandidaat.json) bron.json = kandidaat.json;
  return bron;
}

function bepaalSoort(soortKeuze, gebruiktSoort, url, oordeel, geminiSoort) {
  const redenen = [];
  if (gebruiktSoort === "agenda") redenen.push("de test met het agenda-venster slaagde");
  if (agendaAchtig(url)) redenen.push("de url wijst op een agenda");
  if (geminiSoort === "agenda") redenen.push("Gemini ziet de pagina als een agenda");
  if (oordeel.statistieken.agendaUitDatums) redenen.push(oordeel.statistieken.agendaUitDatums);

  if (soortKeuze === "agenda") return { soort: "agenda", redenen: ["op jouw keuze"], waarschuwing: null };
  if (soortKeuze === "nieuws") {
    const waarschuwing = redenen.length
      ? `Je koos soort "nieuws", maar ${redenen.slice(0, 2).join(" en ")}. Als dit toch een agenda is, voeg de bron dan opnieuw toe met soort "agenda" of "auto"; anders worden toekomstige evenementen als nieuws behandeld.`
      : null;
    return { soort: undefined, redenen: ["op jouw keuze"], waarschuwing };
  }
  return { soort: redenen.length ? "agenda" : undefined, redenen, waarschuwing: null };
}

async function ontdekBron(opties) {
  startResponsCache();
  try {
    return await ontdekBronIntern(opties);
  } finally {
    stopResponsCache();
  }
}

async function ontdekBronIntern(opties) {
  const { url, id, categorie = "lokaal", soort: soortKeuze = "auto", apiKey, vraagGemini, log = console } = opties;
  const naam = opties.naam || id;
  const basis = { id, naam, categorie };
  const verslag = [];
  const behoud = { detailSelector: opties.detailSelector };

  // NIEUW: is de URL zelf een feed? Dan is er niets uit te zoeken, en is
  // Gemini niet nodig. Dit moet VOOR de Gemini-verplichting hieronder.
  log.log(`Controleren of ${url} een feed is...`);
  if (await isDirecteFeed(url)) {
    log.log(`  Ja — de URL is een RSS/Atom-feed. Direct testen als rss-bron (geen Gemini nodig).`);
    const testBronConfig = { ...basis, type: "rss", url };
    const oordeel = await testBron(testBronConfig, { feedModus: true, siteUrl: url });
    if (oordeel.geslaagd) {
      noteer(verslag, log, "directe-feed", { type: "rss", url }, oordeel);
      const bron = { ...basis, type: "rss", url };
      if (soortKeuze === "agenda") bron.soort = "agenda";
      if (oordeel.rustig) bron.rustig = true;
      return { bron, oordeel, verslag };
    }
    log.log(`  De feed gaf geen bruikbare berichten: ${oordeel.redenen[0] || "onbekende reden"}`);
    return {
      bron: null,
      oordeel: null,
      verslag,
      fout: `De URL is een geldige RSS/Atom-feed, maar bevat geen bruikbare berichten (${oordeel.redenen.join("; ") || "geen titel, link of datum"}).`,
    };
  }
  log.log(`  Nee — geen feed, doorgaan met de gewone analyse.`);

  if (!apiKey && !vraagGemini) {
    verslag.push({ stap: "gemini", kandidaat: "gemini", uitkomst: "afgekeurd", redenen: [GEMINI_VERPLICHT_MELDING], waarschuwingen: [], aantal: 0 });
    return { bron: null, oordeel: null, verslag, fout: GEMINI_VERPLICHT_MELDING };
  }

  log.log(`Bron ophalen: ${url}`);
  let html;
  try {
    html = await haalOp(url);
  } catch (fout) {
    return { bron: null, oordeel: null, verslag, fout: `Kon de pagina niet ophalen: ${fout.message}${oorzaakTekst(fout)}` };
  }
  const $ = cheerio.load(html);
  const paginaLinks = verzamelPaginaLinks($, url);

  let infraGezien = false;
  let reserve = null;

  log.log("\nStap 0: Gemini laat de volledige paginacode lezen (referentie voor alle methodes)");
  const { geminiAnalyse, geminiPad } = require("./gemini-recept-lus");
  let analyse = null;
  try {
    analyse = await geminiAnalyse({ $, html, url, paginaLinks, apiKey, vraagGemini, verslag, log });
  } catch (fout) {
    log.log(`  Gemini-analyse mislukte onverwacht: ${fout.message}`);
    verslag.push({ stap: "gemini-analyse", kandidaat: "gemini: analyse van de pagina", uitkomst: "afgekeurd", redenen: [`Onverwachte fout: ${fout.message}`], waarschuwingen: [], aantal: 0 });
  }
  const referentie = analyse ? analyse.referentie : [];
  const geminiSoort = analyse ? analyse.soort : null;
  const totaalGezien = analyse ? analyse.totaalGezien : null;
  if (referentie.length > 0) {
    const totaalTekst = totaalGezien && totaalGezien > referentie.length ? ` (Gemini zegt ${totaalGezien} berichten te zien; ${referentie.length} titels worden als referentie gebruikt)` : "";
    log.log(`  Referentie: Gemini ziet ${referentie.length} bericht(en) op de pagina${totaalTekst}. Elke methode moet er minstens ${Math.round(MIN_DEKKING * 100)}% van terugvinden.`);
    verslag.push({ stap: "gemini-analyse", kandidaat: "gemini: lijst van berichten op de pagina", uitkomst: "geslaagd", redenen: [], waarschuwingen: [], aantal: referentie.length });
  } else {
    const w = "Gemini gaf geen (gecontroleerde) lijst van berichten op de pagina. Elke methode kan nu alleen als twijfel slagen, omdat de volledigheid niet te bewijzen is.";
    log.log(`  ⚠️  ${w}`);
    verslag.push({ stap: "gemini-analyse", kandidaat: "gemini: lijst van berichten op de pagina", uitkomst: "afgekeurd", redenen: [w], waarschuwingen: [], aantal: 0 });
  }
  const refExtra = { verwacht: referentie, zonderReferentie: referentie.length === 0, totaalGezien };
  const padKandidaten = analyse ? analyse.padKandidaten : [];

  const agendaVoorkeur = soortKeuze === "agenda" || (soortKeuze === "auto" && (agendaAchtig(url) || geminiSoort === "agenda"));

  async function testKandidaat(kandidaat, extra = {}) {
    let eerste = null;
    if (SELECTOR_TYPES.includes(kandidaat.type) && analyse && analyse.paginering && !kandidaat.paginering) {
      kandidaat = { ...kandidaat, paginering: analyse.paginering };
    }
    for (const variant of soortVarianten(kandidaat.type, soortKeuze, url, geminiSoort)) {
      const testBronConfig = { ...basis, ...kandidaat, ...(variant ? { soort: variant } : {}) };
      if (behoud.detailSelector && !testBronConfig.detailSelector) testBronConfig.detailSelector = behoud.detailSelector;
      const oordeel = await testBron(testBronConfig, { siteUrl: url, ...extra });
      const resultaat = { kandidaat, oordeel, gebruiktSoort: variant };
      if (oordeel.geslaagd) return resultaat;
      if (!eerste) eerste = resultaat;
    }
    return eerste;
  }

  function verwerk(stap, resultaat, datumSoort = "gebeurtenis") {
    noteer(verslag, log, stap, resultaat.kandidaat, resultaat.oordeel);
    if (resultaat.oordeel.infra) infraGezien = true;
    if (!resultaat.oordeel.geslaagd) return null;
    let soort;
    if (datumSoort === "publicatie") {
      soort = undefined;
      if (soortKeuze === "agenda" || agendaVoorkeur) {
        const w = "Deze methode levert de publicatiedatum van berichten, niet de datum van het evenement. De bron wordt daarom als gewoon nieuws opgeslagen: nieuw geplaatste evenementen verschijnen, evenementen die al lang op de site staan niet.";
        resultaat.oordeel.waarschuwingen.push(w);
        log.log(`    ⚠️  ${w}`);
      }
    } else {
      const keuze = bepaalSoort(soortKeuze, resultaat.gebruiktSoort, url, resultaat.oordeel, geminiSoort);
      soort = keuze.soort;
      if (soort === "agenda" && soortKeuze === "auto") {
        const m = `Soort automatisch herkend als agenda: ${keuze.redenen.join("; ")}.`;
        resultaat.oordeel.soortReden = m;
        log.log(`    ℹ️  ${m}`);
      }
      if (keuze.waarschuwing) {
        resultaat.oordeel.waarschuwingen.push(keuze.waarschuwing);
        log.log(`    ⚠️  ${keuze.waarschuwing}`);
      }
    }
    const bron = bouwEindBron(basis, resultaat.kandidaat, resultaat.oordeel, soort, behoud);
    if (resultaat.oordeel.twijfel) {
      if (!reserve) reserve = { bron, oordeel: resultaat.oordeel };
      return null;
    }
    return { bron, oordeel: resultaat.oordeel, verslag };
  }

  const stappen = {
    feed: async () => {
      const feeds = feedKandidaten(url, $);
      log.log(`RSS/Atom-feeds proberen (${feeds.length} kandidaten)...`);
      for (const feedUrl of feeds) {
        const tekst = await probeerTekst(feedUrl);
        if (!tekst || !/<(rss|feed|rdf:RDF)[\s>]/i.test(tekst.slice(0, 2000))) continue;
        const klaar = verwerk("feed", await testKandidaat({ type: "rss", url: feedUrl }, { paginaLinks, ...refExtra }), "publicatie");
        if (klaar) return klaar;
      }
      return null;
    },

    "wp-rest": async () => {
      log.log("WordPress REST API proberen...");
      const rest = await restKandidaten($, url);
      if (rest.length === 0) log.log("  (geen REST API gevonden)");
      for (const endpoint of rest) {
        const klaar = verwerk("wp-rest", await testKandidaat({ type: "wp-rest", url: endpoint }, { paginaLinks, ...refExtra }), "publicatie");
        if (klaar) return klaar;
      }
      return null;
    },

    "json-ld": async () => {
      log.log("JSON-LD (schema.org) proberen...");
      if ($('script[type="application/ld+json"]').length === 0) {
        log.log("  (geen JSON-LD in de pagina)");
        return null;
      }
      return verwerk("json-ld", await testKandidaat({ type: "json-ld", url }, { paginaLinks, ...refExtra }));
    },

    generiek: async () => {
      log.log("Generieke patronen proberen...");
      const generiek = probeerGeneriekePatronen($, { ...basis, url, ...(agendaVoorkeur ? { soort: "agenda" } : {}) });
      if (!generiek) {
        log.log("  (geen enkel generiek patroon leverde 3 bruikbare berichten)");
        return null;
      }
      log.log(`  Patroon "${generiek.selector}" vond ${generiek.berichten.length} bericht(en), nu testen met de echte scraper...`);
      return verwerk("generieke-lijst", await testKandidaat({ type: "generieke-lijst", url }, { ...refExtra, padKandidaten }));
    },

    gemini: async () => {
      if (!analyse) {
        log.log("  (overgeslagen: de Gemini-analyse van stap 0 is mislukt)");
        return null;
      }
      log.log("Het recept van Gemini testen (en zo nodig laten bijsturen)...");
      const uitkomst = await geminiPad({ $, url, paginaLinks, analyse, testKandidaat, verwerk, verslag, log });
      return uitkomst.klaar || null;
    },
  };

  const volgorde = agendaVoorkeur ? ["json-ld", "generiek", "gemini", "feed", "wp-rest"] : ["feed", "wp-rest", "json-ld", "generiek", "gemini"];
  if (agendaVoorkeur) {
    log.log("\nDit lijkt een agenda: eerst methodes die de datum van het evenement geven, feed en REST (publicatiedatum) als laatste redmiddel.");
  }
  let stapNummer = 0;
  for (const naamStap of volgorde) {
    stapNummer++;
    log.log(`\nStap ${stapNummer}/${volgorde.length}: ${naamStap}`);
    const klaar = await stappen[naamStap]();
    if (klaar) return klaar;
  }

  if (reserve) {
    log.log("\nAlleen een twijfelachtige kandidaat gevonden (slaagt de poort, maar staat niet als link op de pagina).");
    return { bron: reserve.bron, oordeel: reserve.oordeel, verslag, twijfelachtig: true };
  }

  if (infraGezien) {
    return {
      bron: null,
      oordeel: null,
      verslag,
      fout: "De site was tijdens het testen (deels) niet bereikbaar vanaf GitHub, dus niet alle methodes konden eerlijk worden beoordeeld. Probeer het over een paar minuten opnieuw.",
    };
  }
  return { bron: null, oordeel: null, verslag, fout: "Geen enkele methode haalde de poort." };
}

function maakRapport({ url, id, verslag, fout }) {
  const regels = [`## Bron ${id}: wat er geprobeerd is`, "", `Pagina: ${url}`, ""];
  if (fout) regels.push(`**Uitkomst:** ${fout}`, "");
  for (const v of verslag) {
    regels.push(`- **${v.uitkomst}** ${v.kandidaat}${v.aantal ? ` (${v.aantal} bericht(en)${v.tekst ? `, ${v.tekst}` : ""})` : ""}`);
    for (const r of v.redenen || []) regels.push(`  - ${r}`);
    for (const w of v.waarschuwingen || []) regels.push(`  - waarschuwing: ${w}`);
  }
  regels.push("");
  return regels.join("\n");
}

function schrijfStapSamenvatting(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } catch {
    /* de samenvatting is een extraatje, nooit een reden om te falen */
  }
}

module.exports = { ontdekBron, maakRapport, agendaAchtig, verzamelPaginaLinks, soortVarianten, schrijfStapSamenvatting, bepaalSoort, isDirecteFeed, GEMINI_VERPLICHT_MELDING };
