// gemini-recept-lus.js
//
// De Gemini-stap van bron-ontdekking.js. Gemini leest ALTIJD als eerste de
// HELE pagina, één keer (geminiAnalyse), en bedenkt hoe de berichten voortaan
// automatisch opgehaald kunnen worden (een "recept"). Daarna doet gewone code
// dat elke nacht gratis en vast; Gemini is dus alleen het uitzoekwerk.
//
// Die eerste vraag levert vier dingen op die voor ELKE methode gelden (feed,
// REST, JSON-LD, patronen en het recept zelf):
//   - de lijst van berichten die Gemini op de pagina ziet: de referentie
//     waartegen elke methode wordt gecontroleerd;
//   - het TOTALE aantal berichten dat Gemini denkt te zien (totaalGezien): als
//     dat hoger is dan zijn titellijst, weten we dat onze test zwakker is;
//   - of de pagina een agenda is (soort);
//   - hoe de paginering werkt, en waar de tekst van elk bericht staat.
// Is de eerste vraag gesteld, dan test geminiPad (als laatste redmiddel, na de
// andere methodes) het recept van Gemini en laat hij Gemini zo nodig bijsturen.
//
// Drie dingen maken dit betrouwbaar in plaats van hopen:
//
//   1. De hele pagina (opgeschoond), niet de eerste 25.000 tekens. Scripts,
//      svg, inline styles en data-uris gaan eruit, zodat Gemini structuur
//      ziet in plaats van ruis. Wat overblijft past ruim in de context.
//
//   2. Gemini geeft naast het recept ook een lijst van ALLE berichten die hij
//      zelf op de pagina ziet. De code controleert eerst of die links echt in
//      de pagina staan (tegen verzinsels), en de poort eist daarna dat het
//      recept die lijst voor minstens 85% terugvindt. Vindt het recept 3 van
//      de 12, dan wordt het afgekeurd.
//
//   3. Afgekeurd? Dan probeert Gemini het opnieuw, met CONCRETE feedback:
//      hoeveel elementen de selector matchte, welke berichten ontbraken en de
//      HTML rondom die berichten. Poging 2 en 3 gebruiken een sterker model;
//      vanaf poging 3 geeft de code ook kandidaat-blokken (herhalende
//      elementen die de gezochte links bevatten) waaruit Gemini kan kiezen.
//
// Gemini kiest ook de ROUTE: selectors (CSS), een feed-url, of een JSON-API.
// Elke route gaat daarna door dezelfde poort als alle andere methodes.
//
// Sinds Deel B: de prompt vraagt ook naar fotoSelector en fotoAttribuut,
// zodat een nieuwe bron meteen het juiste element voor de afbeelding vindt
// (als de pagina er een toont). Staat er geen foto op de pagina, dan mag
// Gemini dat gewoon zeggen: fotoSelector = null is een geldig antwoord.

const cheerio = require("cheerio");
const { normaliseerUrl, registreerbaarDomein } = require("./bron-poort");
const { leesItem } = require("./scrapers/gemini-recept");

const MAX_HTML_TEKENS = Number(process.env.MAX_HTML_TEKENS_VOOR_GEMINI || 400_000);
const MAX_POGINGEN = Number(process.env.MAX_GEMINI_POGINGEN || 4);
const MODELLEN = (process.env.GEMINI_MODELLEN || "gemini-flash-lite-latest,gemini-flash-latest,gemini-pro-latest")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_GEZIEN = 50;
const MAX_HTML_VOORBEELD = 1200;
const MAX_TOTAAL_GEZIEN = 10000; // onzin-filter: groter dan dit negeren we

const ATTRIBUTEN_WEG = new Set(["style", "srcset", "sizes", "loading", "decoding", "fetchpriority", "tabindex", "integrity", "crossorigin", "nonce"]);

// ---------------------------------------------------------------------------
// 1. De pagina opschonen
// ---------------------------------------------------------------------------

/**
 * Maakt de HTML compact zonder de structuur aan te tasten: alleen dingen die
 * nooit een bericht bevatten gaan eruit. Selectors die Gemini op deze versie
 * bedenkt, werken daarom ook op de originele pagina.
 *
 * Geeft { html, hints, ingekort }. hints zijn de dingen die je uit de
 * scripts en de head wilt weten voor een feed- of API-route, in korte vorm.
 */
function maakSchoneHtml(html, paginaUrl) {
  const $ = cheerio.load(html);

  // Aanwijzingen verzamelen voordat de scripts verdwijnen.
  const hints = [];
  $('link[rel~="alternate"]').each((_, el) => {
    const type = $(el).attr("type");
    const href = $(el).attr("href");
    if (href && type && /rss|atom|json/i.test(type)) hints.push(`feed-link (${type}): ${new URL(href, paginaUrl).toString()}`);
  });
  const apiHref = $('link[rel="https://api.w.org/"]').attr("href");
  if (apiHref) hints.push(`WordPress REST API: ${new URL(apiHref, paginaUrl).toString()}`);
  const scriptBronnen = [];
  $("script[src]").each((_, el) => {
    if (scriptBronnen.length < 25) scriptBronnen.push($(el).attr("src"));
  });
  if (scriptBronnen.length) hints.push(`scripts: ${scriptBronnen.join(", ")}`);
  $('script[type="application/json"], script[type="application/ld+json"]').each((i, el) => {
    if (i >= 5) return;
    const inhoud = $(el).contents().text().trim();
    if (inhoud) hints.push(`${$(el).attr("type")}${$(el).attr("id") ? ` #${$(el).attr("id")}` : ""} (eerste 3000 tekens): ${inhoud.slice(0, 3000)}`);
  });

  const opschonen = () => {
    $("script, style, svg, noscript, iframe, canvas, template, meta, link[rel=stylesheet], link[rel=preload], link[rel=prefetch]").remove();
    $("*")
      .contents()
      .filter((_, n) => n.type === "comment")
      .remove();
    $("*").each((_, el) => {
      const attributen = el.attribs;
      if (!attributen) return;
      for (const naam of Object.keys(attributen)) {
        const waarde = attributen[naam];
        if (ATTRIBUTEN_WEG.has(naam) || naam.startsWith("aria-") || /^on[a-z]+$/.test(naam)) {
          delete attributen[naam];
        } else if (typeof waarde === "string" && waarde.startsWith("data:")) {
          attributen[naam] = "data:…";
        } else if (typeof waarde === "string" && waarde.length > 300) {
          attributen[naam] = `${waarde.slice(0, 300)}…`;
        }
      }
    });
  };
  const naarTekst = () => $.html().replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();

  opschonen();
  let resultaat = naarTekst();
  let ingekort = false;

  // Alleen als het nog steeds te groot is: navigatie, header, footer, zijbalk en formulieren eruit.
  if (resultaat.length > MAX_HTML_TEKENS) {
    $("nav, header, footer, aside, form").remove();
    resultaat = naarTekst();
  }
  if (resultaat.length > MAX_HTML_TEKENS) {
    resultaat = `${resultaat.slice(0, MAX_HTML_TEKENS)}<!-- ingekort -->`;
    ingekort = true;
  }
  return { html: resultaat, hints, ingekort };
}

// ---------------------------------------------------------------------------
// 2. De prompt
// ---------------------------------------------------------------------------

function formatteerFeedback(f) {
  const regels = [`--- POGING ${f.poging} (${f.model || "model onbekend"}, route: ${f.route || "onbekend"}) WAS NIET GOED ---`];
  if (f.toelichting) regels.push(`Jouw toelichting toen: ${f.toelichting}`);
  if (f.recept) regels.push(`Jouw recept was: ${JSON.stringify(f.recept)}`);
  if (f.probleem) regels.push(`Probleem: ${f.probleem}`);
  for (const r of f.redenen || []) regels.push(`Afgekeurd omdat: ${r}`);
  if (f.matchStats) {
    regels.push(
      `De itemSelector matchte ${f.matchStats.matches} element(en) op de pagina; daarvan hadden er ${f.matchStats.metTitel} een titel, ${f.matchStats.metLink} een link en ${f.matchStats.metFoto} een foto. Na controle bleven ${f.aantalGevonden} bruikbare berichten over.`
    );
  } else if (f.aantalGevonden != null) {
    regels.push(`Het recept leverde ${f.aantalGevonden} bruikbare bericht(en) op.`);
  }
  if (f.aantalVerwacht != null) regels.push(`In jouw eigen lijst stonden ${f.aantalVerwacht} berichten.`);
  if (f.totaalGezien != null) regels.push(`Jij zei eerder ${f.totaalGezien} berichten op de pagina te zien.`);
  if (f.padHint) regels.push(f.padHint);
  if (f.voorbeeldGevonden && f.voorbeeldGevonden.length) {
    regels.push("Voorbeelden van wat het recept WEL vond:");
    f.voorbeeldGevonden.forEach((b) => regels.push(`  - "${b.titel}" (${b.url}) datum: ${b.datum || "geen"}`));
  }
  if (f.ontbrekend && f.ontbrekend.length) {
    regels.push("Deze berichten uit jouw eigen lijst vond het recept NIET:");
    f.ontbrekend.forEach((b) => {
      regels.push(`  - "${b.titel}" (${b.url})`);
      if (b.htmlRond) regels.push(`    HTML rondom dit bericht: ${b.htmlRond}`);
    });
  }
  return regels.join("\n");
}

function formatteerKandidaatBlokken(blokken) {
  if (!blokken || blokken.length === 0) return "";
  const regels = [
    "--- KANDIDAAT-BLOKKEN (door de code gevonden) ---",
    "Dit zijn herhalende elementen op de pagina die de links uit jouw eigen lijst bevatten. Kies er een als itemSelector (of een preciezere variant), of geef een eigen recept:",
  ];
  blokken.forEach((b, i) => {
    regels.push(`${i + 1}. ${b.selector}: ${b.aantal} elementen op de pagina, bevat ${b.dekking} van jouw berichten. Voorbeeld: ${b.voorbeeldHtml}`);
  });
  return regels.join("\n");
}

function bouwPrompt({ url, schoon, geschiedenis, kandidaatBlokken }) {
  const feedback = geschiedenis.length ? `\n\n${geschiedenis.map(formatteerFeedback).join("\n\n")}\n\nDoe het nu BETER. Kijk goed naar wat er mis ging en pas je recept daarop aan.` : "";
  const blokken = kandidaatBlokken && kandidaatBlokken.length ? `\n\n${formatteerKandidaatBlokken(kandidaatBlokken)}` : "";
  const hints = schoon.hints.length ? `\n\nAANWIJZINGEN UIT DE HEAD EN DE SCRIPTS:\n${schoon.hints.join("\n")}` : "";

  return `Je krijgt de opgeschoonde HTML van een pagina met een lijst nieuwsberichten of evenementen (${url}).
Bepaal hoe die berichten voortaan automatisch opgehaald kunnen worden. Een script haalt de pagina elke nacht opnieuw op en past jouw recept toe, dus het recept moet ook werken voor berichten die er nu nog niet staan.

Kies precies EEN route:
1. "selectors": de berichten staan in de HTML zelf. Geef CSS-selectors (cheerio) voor het herhalende blok en voor titel, link, datum en (als die er is) foto daarbinnen. Dit is de gebruikelijke route.
2. "feed": een RSS/Atom-feed die de berichten van DEZE pagina bevat (dus geen lege of algemene blog-feed). Alleen kiezen als de aanwijzingen zo'n feed noemen.
3. "json-api": de berichten worden via een JSON-endpoint geladen dat in de aanwijzingen of de HTML zichtbaar is. Geef de url en welke velden titel, link en datum bevatten.
4. "geen": de berichten staan niet in deze HTML (bijvoorbeeld een lege pagina met "Loading..." omdat alles met JavaScript wordt opgebouwd, of een inlogscherm).

Geef daarnaast ALTIJD:
- "totaalGezien": een geheel getal — het TOTALE aantal berichten dat je op deze pagina ziet, ook als dat er meer zijn dan ${MAX_GEZIEN}. Geef het werkelijke totaal (bijvoorbeeld 180), niet het maximum.
- "gezienBerichten": de titels van maximaal ${MAX_GEZIEN} berichten, met titel, url (exact zoals in de href, ook als die relatief is) en datum (zoals zichtbaar, of null). Als er meer dan ${MAX_GEZIEN} berichten zijn, geef dan een representatieve selectie verspreid over de pagina (niet alleen de bovenste ${MAX_GEZIEN}). Laat menu-items, filters, paginering en zijbalklinks weg. De code controleert of jouw recept deze berichten terugvindt; een recept dat er maar een deel van vindt wordt afgekeurd.

Regels voor selectors:
- titelSelector: relatief aan het item-blok. Leeg-string alleen als het hele blok de titel is.
- linkSelector: relatief aan het item-blok. Is het item-blok zelf een <a>-element (de hele kaart is aanklikbaar, dat komt vaak voor), of zit de titel in een link, gebruik dan het woord self. Dat is ook prima: dan mag itemSelector gewoon dat <a>-element zijn.
- datumSelector: relatief aan het item-blok, of null als er geen apart datum-element is. Staat de datum in de titeltekst (bijvoorbeeld "2026-09-22 Dinsdag 22 september 2026 om 17.15 uur - ..."), zet datumSelector dan op null: de titeltekst wordt daarna automatisch op een datum doorzocht. Staat de datum zonder jaar ("30 sep"), laat die dan gewoon zo staan; het jaar wordt door de code aangevuld.
- datumAttribuut: naam van het attribuut waar de datum in staat (bijvoorbeeld datetime), of null om de zichtbare tekst te gebruiken.
- fotoSelector: relatief aan het item-blok: het element met de afbeelding (meestal een <img>), of null als de lijst geen afbeelding bij het bericht toont. Als de pagina helemaal geen foto's toont, zet fotoSelector op null en fotoAttribuut op null: dat is geen fout.
- fotoAttribuut: naam van het attribuut waar de foto-url in staat (meestal src, soms data-src of data-lazy-src), of null om de standaard volgorde te gebruiken (src, data-src, data-lazy-src, data-original, srcset).
- samenvattingSelector: relatief aan het item-blok: het element met de korte tekst of intro van het bericht zoals de lijst die toont, of null als de lijst alleen titels toont.
- Kies selectors die specifiek genoeg zijn om geen menu-items mee te nemen, maar breed genoeg om alle berichten te vangen.

Geef ook ALTIJD:
- "soort": "agenda" als de datum bij de berichten de datum van een evenement is (de pagina kijkt vooruit: concerten, activiteiten, vergaderingen op een toekomstige datum), of "nieuws" als de datum aangeeft wanneer het bericht is geplaatst.
- "paginering": hoe je bij meer berichten komt dan op deze pagina staan. Soort "patroon": een url met {n} op de plek van het paginanummer, waarbij pagina 2 de eerste extra pagina is (bijvoorbeeld https://voorbeeld.nl/agenda/page/{n}/ of https://voorbeeld.nl/nieuws?pagina={n}). Soort "volgende-link": een CSS-selector van de "volgende pagina"-link. Soort "geen": er is geen paginering te zien. Baseer dit alleen op links die in de HTML staan en verzin geen patroon: de code controleert of de pagina naar jouw patroon linkt.

Geef ALLEEN geldige JSON terug, exact dit formaat, geen markdown-fences en geen andere tekst:
{
  "route": "selectors" | "feed" | "json-api" | "geen",
  "toelichting": "een of twee zinnen over je keuze",
  "soort": "agenda" | "nieuws",
  "totaalGezien": 0,
  "selectors": { "itemSelector": "...", "titelSelector": "...", "linkSelector": "...", "datumSelector": "... of null", "datumAttribuut": "... of null", "samenvattingSelector": "... of null", "fotoSelector": "... of null", "fotoAttribuut": "... of null" } of null,
  "paginering": { "soort": "patroon" | "volgende-link" | "geen", "patroon": "https://... met {n}, of null", "volgendeSelector": "css-selector, of null" },
  "feedUrl": "https://... of null",
  "jsonApi": { "url": "https://...", "itemsPad": "pad naar de lijst, bijvoorbeeld data.items, of leeg als de JSON zelf de lijst is", "titelVeld": "...", "linkVeld": "...", "datumVeld": "... of null", "samenvattingVeld": "... of null" } of null,
  "gezienBerichten": [ { "titel": "...", "url": "...", "datum": "... of null" } ]
}${hints}${feedback}${blokken}

HTML:
${schoon.html}`;
}

// ---------------------------------------------------------------------------
// 3. Gemini aanroepen
// ---------------------------------------------------------------------------

function wacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function roepGeminiAan(model, prompt, apiKey) {
  // Tijdelijke fouten krijgen nieuwe kansen: 503/500 (overbelast) tot twee keer opnieuw met
  // oplopende wachttijd, 429 (limiet bereikt) eenmaal. Daarna valt de aanroeper terug op een lichter model.
  for (let poging = 1; poging <= 3; poging++) {
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 16384 },
        }),
      });
    } catch (fout) {
      return { fout: `netwerkfout: ${fout.message}` };
    }
    if (response.ok) {
      const data = await response.json();
      const kandidaat = data?.candidates?.[0];
      const delen = kandidaat?.content?.parts || [];
      const tekst = delen.filter((d) => !d.thought && typeof d.text === "string").map((d) => d.text).join("");
      return tekst ? { tekst, finishReason: kandidaat?.finishReason } : { fout: `leeg antwoord (finishReason: ${kandidaat?.finishReason || "onbekend"})` };
    }
    const wachttijd = [500, 503].includes(response.status) && poging < 3 ? (poging === 1 ? 5000 : 15000) : response.status === 429 && poging === 1 ? 10000 : null;
    if (wachttijd === null) return { fout: `HTTP ${response.status}` };
    await wacht(wachttijd);
  }
  return { fout: "onbekende fout" };
}

/** Standaard-aanroep: het gewenste model, en als dat niet lukt (niet beschikbaar, limiet) telkens het model eronder. */
function maakStandaardVraag(apiKey, log) {
  return async ({ modelIndex, prompt }) => {
    for (let i = modelIndex; i >= 0; i--) {
      const uit = await roepGeminiAan(MODELLEN[i], prompt, apiKey);
      if (uit.tekst && leesAntwoord(uit.tekst)) return uit.tekst;
      const reden = uit.tekst
        ? `antwoord is geen geldige JSON (finishReason: ${uit.finishReason || "onbekend"}, ${uit.tekst.length} tekens, begint met: ${JSON.stringify(uit.tekst.slice(0, 120))})`
        : uit.fout;
      log.log(`  Gemini (${MODELLEN[i]}) mislukte: ${reden}${i > 0 ? `; terugvallen op ${MODELLEN[i - 1]}` : ""}`);
    }
    return null;
  };
}

/** Leest het antwoord van Gemini: object of JSON-tekst (eventueel met markdown-fences). */
function leesAntwoord(ruw) {
  if (ruw && typeof ruw === "object") return ruw;
  if (typeof ruw !== "string") return null;
  const schoon = ruw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(schoon);
  } catch {
    // Soms staat er tekst voor of na de JSON; pak dan alles tussen de eerste { en de laatste }.
    const begin = schoon.indexOf("{");
    const eind = schoon.lastIndexOf("}");
    if (begin !== -1 && eind > begin) {
      try {
        return JSON.parse(schoon.slice(begin, eind + 1));
      } catch {
        /* echt geen JSON */
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Antwoord controleren en omzetten naar een kandidaat-bron
// ---------------------------------------------------------------------------

function geldigeSelector(selector) {
  try {
    cheerio.load("<div></div>")(selector);
    return true;
  } catch {
    return false;
  }
}

function absoluut(href, basis) {
  try {
    const u = new URL(href, basis);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Controleert Gemini's beschrijving van de paginering tegen de echte pagina.
 * Een patroon wordt alleen geaccepteerd als de pagina zelf naar pagina 2 linkt
 * volgens dat patroon; een "volgende"-selector alleen als hij een link vindt.
 * Geeft { paginering, probleem }: paginering is null bij "geen" of als het niet te bevestigen was.
 */
function valideerPaginering(p, { url, paginaLinks, $ }) {
  if (!p || typeof p !== "object" || !p.soort || p.soort === "geen") return { paginering: null, probleem: null };

  if (p.soort === "patroon") {
    if (typeof p.patroon !== "string" || !p.patroon.includes("{n}")) {
      return { paginering: null, probleem: 'Paginering "patroon" genegeerd: er staat geen {n} (plek van het paginanummer) in.' };
    }
    let sjabloon;
    try {
      sjabloon = new URL(p.patroon.replace("{n}", "__N__"), url).toString();
    } catch {
      return { paginering: null, probleem: `Paginering genegeerd: "${p.patroon}" is geen geldige url.` };
    }
    const proef = sjabloon.replace("__N__", "2");
    if (registreerbaarDomein(proef) !== registreerbaarDomein(url)) {
      return { paginering: null, probleem: `Paginering genegeerd: ${proef} staat niet op dezelfde site.` };
    }
    if (!paginaLinks.has(normaliseerUrl(proef))) {
      return { paginering: null, probleem: `Paginering genegeerd: de pagina bevat geen link naar ${proef}, dus het patroon is niet te bevestigen.` };
    }
    return { paginering: { soort: "patroon", patroon: sjabloon.replace("__N__", "{n}") }, probleem: null };
  }

  if (p.soort === "volgende-link") {
    const selector = typeof p.volgendeSelector === "string" ? p.volgendeSelector.trim() : "";
    if (!selector || !geldigeSelector(selector)) {
      return { paginering: null, probleem: `Paginering genegeerd: "${selector}" is geen geldige CSS-selector.` };
    }
    const heeftLink = $(selector).filter((_, el) => $(el).is("a[href]") || $(el).find("a[href]").length > 0).length > 0;
    if (!heeftLink) {
      return { paginering: null, probleem: `Paginering genegeerd: de selector "${selector}" vindt geen link op de pagina.` };
    }
    return { paginering: { soort: "volgende-link", selector }, probleem: null };
  }

  return { paginering: null, probleem: `Paginering genegeerd: onbekende soort "${p.soort}".` };
}

function valideerAntwoord(antwoord, { url, paginaLinks, $ }) {
  const uit = {
    route: antwoord.route,
    toelichting: antwoord.toelichting,
    kandidaat: null,
    probleem: null,
    gezien: [],
    verzonnen: 0,
    totaalGezien: null,
    soort: antwoord.soort === "agenda" || antwoord.soort === "nieuws" ? antwoord.soort : null,
    paginering: null,
    pagineringProbleem: null,
  };

  // totaalGezien: Gemini's eigen schatting. Afronden op geheel getal, en
  // onzin-waarden negeren (negatief, niet-numeriek, of belachelijk groot).
  const tg = Number(antwoord.totaalGezien);
  if (Number.isFinite(tg) && tg > 0 && tg <= MAX_TOTAAL_GEZIEN) {
    uit.totaalGezien = Math.floor(tg);
  }

  if ($) {
    const { paginering, probleem } = valideerPaginering(antwoord.paginering, { url, paginaLinks, $ });
    uit.paginering = paginering;
    uit.pagineringProbleem = probleem;
  }

  const gezien = [];
  const gezienSet = new Set();
  for (const b of Array.isArray(antwoord.gezienBerichten) ? antwoord.gezienBerichten : []) {
    if (!b || typeof b.url !== "string") continue;
    const volledig = absoluut(b.url, url);
    const norm = volledig && normaliseerUrl(volledig);
    if (!norm || gezienSet.has(norm)) continue;
    if (!paginaLinks.has(norm)) {
      uit.verzonnen++;
      continue;
    }
    gezienSet.add(norm);
    gezien.push({ titel: String(b.titel || "").trim(), url: volledig, datum: b.datum || null });
    if (gezien.length >= MAX_GEZIEN) break;
  }
  uit.gezien = gezien;

  switch (antwoord.route) {
    case "selectors": {
      const s = antwoord.selectors;
      if (!s || typeof s.itemSelector !== "string" || !s.itemSelector.trim()) {
        uit.probleem = 'Route "selectors" gekozen, maar er staat geen itemSelector in het antwoord.';
        break;
      }
      if (!s.linkSelector) {
        uit.probleem = 'Er staat geen linkSelector in het antwoord (gebruik het woord "self" als de titel zelf de link is).';
        break;
      }
      const alle = [s.itemSelector, s.titelSelector, s.datumSelector, s.samenvattingSelector, s.fotoSelector].filter((x) => typeof x === "string" && x.trim());
      if (s.linkSelector !== "self") alle.push(s.linkSelector);
      const kapot = alle.find((sel) => !geldigeSelector(sel));
      if (kapot) {
        uit.probleem = `De selector "${kapot}" is geen geldige CSS-selector.`;
        break;
      }
      uit.kandidaat = {
        type: "gemini-recept",
        url,
        selectors: {
          itemSelector: s.itemSelector.trim(),
          titelSelector: typeof s.titelSelector === "string" ? s.titelSelector.trim() : "",
          linkSelector: s.linkSelector,
          datumSelector: typeof s.datumSelector === "string" && s.datumSelector.trim() ? s.datumSelector.trim() : null,
          datumAttribuut: typeof s.datumAttribuut === "string" && s.datumAttribuut.trim() ? s.datumAttribuut.trim() : null,
          samenvattingSelector: typeof s.samenvattingSelector === "string" && s.samenvattingSelector.trim() ? s.samenvattingSelector.trim() : null,
          fotoSelector: typeof s.fotoSelector === "string" && s.fotoSelector.trim() ? s.fotoSelector.trim() : null,
          fotoAttribuut: typeof s.fotoAttribuut === "string" && s.fotoAttribuut.trim() ? s.fotoAttribuut.trim() : null,
        },
        ...(uit.paginering ? { paginering: uit.paginering } : {}),
      };
      break;
    }
    case "feed": {
      const feedUrl = typeof antwoord.feedUrl === "string" ? absoluut(antwoord.feedUrl, url) : null;
      if (!feedUrl) uit.probleem = 'Route "feed" gekozen, maar feedUrl ontbreekt of is geen geldige url.';
      else uit.kandidaat = { type: "rss", url: feedUrl };
      break;
    }
    case "json-api": {
      const j = antwoord.jsonApi;
      const apiUrl = j && typeof j.url === "string" ? absoluut(j.url, url) : null;
      if (!apiUrl || !j.titelVeld || !j.linkVeld) {
        uit.probleem = 'Route "json-api" gekozen, maar url, titelVeld of linkVeld ontbreekt.';
        break;
      }
      const json = { itemsPad: j.itemsPad || "", titelVeld: j.titelVeld, linkVeld: j.linkVeld };
      if (j.datumVeld) json.datumVeld = j.datumVeld;
      if (j.samenvattingVeld) json.samenvattingVeld = j.samenvattingVeld;
      uit.kandidaat = { type: "json-api", url: apiUrl, json };
      break;
    }
    case "geen":
      uit.probleem = "Gemini ziet geen berichten in de HTML (waarschijnlijk met JavaScript opgebouwd of achter een login).";
      break;
    default:
      uit.probleem = `Onbekende route "${antwoord.route}" (verwacht: selectors, feed, json-api of geen).`;
  }
  return uit;
}

// ---------------------------------------------------------------------------
// 5. Feedback voor een volgende poging
// ---------------------------------------------------------------------------

/**
 * Diagnose van een selector-recept op de echte pagina: hoeveel elementen de
 * itemSelector matcht en hoeveel daarvan een titel, link en foto opleveren.
 * Gebruikt leesItem uit de scraper zelf, dus de uitkomst is gegarandeerd
 * hetzelfde als wat de dagelijkse run met dit recept zou zien.
 */
function analyseerSelectors($, selectors, paginaUrl) {
  const stats = { matches: 0, metTitel: 0, metLink: 0, metFoto: 0 };
  $(selectors.itemSelector).each((_, el) => {
    stats.matches++;
    const { titel, link, foto } = leesItem($, el, selectors, paginaUrl);
    if (titel) stats.metTitel++;
    if (link) stats.metLink++;
    if (foto) stats.metFoto++;
  });
  return stats;
}

/** Het herhalende HTML-blok rondom een link, ingekort. Laat Gemini zien hoe een bericht dat het recept miste er echt uitziet. */
function htmlRondLink($, doelNorm, paginaUrl) {
  let anker = null;
  $("a[href]").each((_, el) => {
    if (!anker && normaliseerUrl($(el).attr("href"), paginaUrl) === doelNorm) anker = el;
  });
  if (!anker) return null;
  let el = anker;
  for (let stap = 0; stap < 6; stap++) {
    const ouder = el.parent;
    if (!ouder || ouder.type !== "tag" || ["body", "html"].includes(ouder.name)) break;
    if (stap >= 1 && $(ouder).children(el.name).length >= 3) break; // el is een van meerdere gelijke broers: dit is het herhalende blok
    el = ouder;
  }
  return $.html(el).replace(/\s+/g, " ").slice(0, MAX_HTML_VOORBEELD);
}

function selectorVoor($, el) {
  const klassen = ($(el).attr("class") || "").split(/\s+/).filter((k) => /^[A-Za-z_][\w-]*$/.test(k)).slice(0, 3);
  return `${el.name}${klassen.map((k) => `.${k}`).join("")}`;
}

/**
 * Zoekt herhalende blokken die de referentie-links bevatten. Werkt zonder AI:
 * voor elke referentie-link omhoog lopen door de voorouders, en tellen
 * welke tag+klasse-combinaties vaak voorkomen en veel referenties omvatten.
 */
function vindKandidaatBlokken($, referentieUrls, paginaUrl) {
  const doelen = new Set(referentieUrls.map((u) => normaliseerUrl(u)));
  const ankers = [];
  $("a[href]").each((_, el) => {
    const norm = normaliseerUrl($(el).attr("href"), paginaUrl);
    if (doelen.size ? doelen.has(norm) : $(el).closest("h1, h2, h3, h4").length) ankers.push(el);
  });
  if (ankers.length < 2) return [];

  const perSelector = new Map();
  ankers.forEach((anker, index) => {
    let el = anker.parent;
    for (let stap = 0; stap < 6 && el && el.type === "tag" && !["body", "html"].includes(el.name); stap++, el = el.parent) {
      const sel = selectorVoor($, el);
      if (!perSelector.has(sel)) perSelector.set(sel, new Set());
      perSelector.get(sel).add(index);
    }
  });

  const minimaal = Math.max(2, Math.ceil(ankers.length * 0.5));
  return [...perSelector.entries()]
    .map(([selector, dekking]) => ({ selector, dekking: dekking.size, aantal: $(selector).length }))
    .filter((b) => b.dekking >= minimaal && b.aantal >= 2 && b.aantal <= 300)
    .sort((a, b) => b.dekking - a.dekking || Math.abs(a.aantal - ankers.length) - Math.abs(b.aantal - ankers.length))
    .slice(0, 5)
    .map((b) => ({ ...b, voorbeeldHtml: $.html($(b.selector).first()).replace(/\s+/g, " ").slice(0, MAX_HTML_VOORBEELD) }));
}

/** Links onder hetzelfde pad als de lijstpagina (geen filters, geen paginering): de "verwachte" berichtlinks. */
function bepaalPadKandidaten(paginaLinks, url) {
  const eigen = normaliseerUrl(url);
  if (!eigen) return [];
  const pad = eigen.replace(/\?.*$/, "");
  const padDeel = pad.replace(/^[^/]+/, "");
  if (padDeel === "" || padDeel === "/") return []; // startpagina: te veel ruis (menu, footer)
  return [...paginaLinks].filter((l) => !l.includes("?") && l.startsWith(`${pad}/`) && !/\/(page|pagina)\/\d+$/.test(l));
}

function bouwFeedback({ poging, model, v, resultaat, $, url, verwacht, padKandidaten }) {
  const oordeel = resultaat ? resultaat.oordeel : null;
  const f = {
    poging,
    model,
    route: v.route,
    toelichting: v.toelichting,
    recept: v.kandidaat ? v.kandidaat.selectors || v.kandidaat.json || v.kandidaat.url : null,
    probleem: v.probleem,
    redenen: oordeel ? oordeel.redenen : [],
    aantalGevonden: oordeel ? oordeel.aantal : null,
    aantalVerwacht: verwacht.length || null,
    totaalGezien: v.totaalGezien || null,
    voorbeeldGevonden: oordeel ? oordeel.geldig.slice(0, 3).map((b) => ({ titel: b.titel, url: b.url, datum: b.gepubliceerdOp ? String(b.gepubliceerdOp).slice(0, 10) : null })) : [],
    ontbrekend: [],
  };
  if (v.kandidaat && v.kandidaat.selectors) {
    try {
      f.matchStats = analyseerSelectors($, v.kandidaat.selectors, url);
    } catch {
      /* ongeldige selector is al als probleem gemeld */
    }
  }
  if (oordeel && oordeel.ontbrekend.length) {
    f.ontbrekend = oordeel.ontbrekend.slice(0, 5).map((b, i) => ({
      titel: b.titel,
      url: b.url,
      htmlRond: i < 3 ? htmlRondLink($, normaliseerUrl(b.url), url) : null,
    }));
  }
  if (oordeel && oordeel.statistieken.padKandidaten) {
    f.padHint = `Op de pagina staan ${oordeel.statistieken.padKandidaten} links onder hetzelfde pad als de lijstpagina; het recept dekte ${Math.round(oordeel.statistieken.padDekking * 100)}% daarvan.`;
  } else if (padKandidaten.length >= 6 && oordeel) {
    f.padHint = `Op de pagina staan ${padKandidaten.length} links onder hetzelfde pad als de lijstpagina.`;
  }
  return f;
}

// ---------------------------------------------------------------------------
// 6. De lus
// ---------------------------------------------------------------------------

/**
 * Eén vraag aan Gemini: prompt bouwen, antwoord lezen en controleren. Geeft
 * { v } bij een bruikbaar antwoord, anders { v: null, probleem }.
 */
async function vraagVoorstel({ poging, model, modelIndex, vraag, schoon, geschiedenis, kandidaatBlokken, url, $, paginaLinks, log, verslag }) {
  const prompt = bouwPrompt({ url, schoon, geschiedenis, kandidaatBlokken });

  let antwoord = null;
  try {
    antwoord = leesAntwoord(await vraag({ model, modelIndex, prompt, poging }));
  } catch (fout) {
    log.log(`  Gemini-aanroep mislukte: ${fout.message}`);
  }
  if (!antwoord) {
    const probleem = "Gemini gaf geen bruikbaar antwoord (geen geldige JSON).";
    log.log(`  ✗ ${probleem}`);
    verslag.push({ stap: `gemini-poging-${poging}`, kandidaat: `gemini poging ${poging} (${model})`, uitkomst: "afgekeurd", redenen: [probleem], waarschuwingen: [], aantal: 0 });
    return { v: null, probleem };
  }

  const v = valideerAntwoord(antwoord, { url, paginaLinks, $ });
  const extra = v.totaalGezien ? `, zegt ${v.totaalGezien} berichten op de pagina te zien` : "";
  log.log(`  Gemini koos route "${v.route}"; ziet ${v.gezien.length} bericht(en) op de pagina${extra}${v.verzonnen ? ` (${v.verzonnen} verzonnen link(s) genegeerd)` : ""}.`);
  if (v.soort) log.log(`  Gemini ziet dit als: ${v.soort === "agenda" ? "een agenda (de datum is de datum van het evenement)" : "nieuws (de datum is de publicatiedatum)"}.`);
  if (v.paginering) log.log(`  Paginering: ${v.paginering.soort === "patroon" ? `patroon ${v.paginering.patroon}` : `volgende-link ${v.paginering.selector}`}.`);
  if (v.pagineringProbleem) log.log(`  ⚠️  ${v.pagineringProbleem}`);
  return { v };
}

/**
 * De eerste vraag aan Gemini, die ALTIJD als eerste gesteld wordt (nog voor
 * feed, REST, JSON-LD en patronen). Geeft de referentielijst, het soort, de
 * paginering en totaalGezien terug, en onthoudt het voorstel van poging 1 voor
 * geminiPad. Faalt Gemini, dan is referentie leeg; de aanroeper meldt dat.
 *
 * ctx komt uit bron-ontdekking.js: $, html, url, paginaLinks, apiKey,
 * vraagGemini (optioneel, voor tests), verslag, log
 */
async function geminiAnalyse(ctx) {
  const { $, html, url, paginaLinks, apiKey, verslag, log } = ctx;
  const vraag = ctx.vraagGemini || maakStandaardVraag(apiKey, log);

  const schoon = maakSchoneHtml(html, url);
  log.log(`  De hele pagina gaat naar Gemini: ${schoon.html.length} tekens (origineel ${html.length}${schoon.ingekort ? ", ingekort" : ""}).`);

  const padKandidaten = bepaalPadKandidaten(paginaLinks, url);
  const model = MODELLEN[0];
  log.log(`\n  Poging 1/${MAX_POGINGEN} (${model})...`);
  const poging1 = await vraagVoorstel({ poging: 1, model, modelIndex: 0, vraag, schoon, geschiedenis: [], kandidaatBlokken: [], url, $, paginaLinks, log, verslag });

  const v = poging1.v;
  return {
    vraag,
    schoon,
    padKandidaten,
    poging1,
    referentie: v ? v.gezien : [],
    totaalGezien: v ? v.totaalGezien : null,
    soort: v ? v.soort : null,
    paginering: v ? v.paginering : null,
  };
}

/**
 * Draait de zelfcorrigerende lus. Poging 1 is al gedaan in geminiAnalyse; die
 * wordt hier alleen getest. Daarna volgen zo nodig verbeterpogingen met
 * feedback. ctx komt uit bron-ontdekking.js:
 *   $, url, paginaLinks, analyse (uitkomst van geminiAnalyse),
 *   testKandidaat(kandidaat, extraOpties), verwerk(stap, resultaat), verslag, log
 * Elke kandidaat wordt getest tegen de referentielijst uit de analyse. Alleen als
 * die leeg is, valt hij terug op de lijst van de poging zelf.
 * Geeft { klaar } terug: het eindresultaat bij succes, anders klaar: null.
 */
async function geminiPad(ctx) {
  const { $, url, paginaLinks, analyse, testKandidaat, verwerk, verslag, log } = ctx;
  const { vraag, schoon, padKandidaten, referentie, totaalGezien } = analyse;

  const geschiedenis = [];
  let laatsteGezien = referentie;
  let geenAchtereen = 0;

  for (let poging = 1; poging <= MAX_POGINGEN; poging++) {
    const modelIndex = Math.min(poging - 1, MODELLEN.length - 1);
    const model = MODELLEN[modelIndex];

    let uit;
    if (poging === 1) {
      log.log(`\n  Recept van poging 1 (${model}) testen...`);
      uit = analyse.poging1;
    } else {
      const kandidaatBlokken = poging >= 3 ? vindKandidaatBlokken($, (referentie.length ? referentie : laatsteGezien).map((g) => g.url), url) : [];
      log.log(`\n  Poging ${poging}/${MAX_POGINGEN} (${model})${kandidaatBlokken.length ? `, met ${kandidaatBlokken.length} kandidaat-blok(ken)` : ""}...`);
      uit = await vraagVoorstel({ poging, model, modelIndex, vraag, schoon, geschiedenis, kandidaatBlokken, url, $, paginaLinks, log, verslag });
    }

    const v = uit.v;
    if (!v) {
      geschiedenis.push({ poging, model, probleem: uit.probleem });
      continue;
    }
    if (v.gezien.length) laatsteGezien = v.gezien;
    const verwacht = referentie.length ? referentie : v.gezien;

    if (v.route === "geen") {
      geenAchtereen++;
    } else {
      geenAchtereen = 0;
    }

    if (!v.kandidaat) {
      log.log(`  ✗ ${v.probleem}`);
      verslag.push({ stap: `gemini-poging-${poging}`, kandidaat: `gemini poging ${poging} (${model}), route ${v.route}`, uitkomst: "afgekeurd", redenen: [v.probleem], waarschuwingen: [], aantal: 0 });
      geschiedenis.push(bouwFeedback({ poging, model, v, resultaat: null, $, url, verwacht, padKandidaten }));
      // Twee keer achter elkaar "geen berichten in de HTML" is een duidelijk signaal (JavaScript-site): niet nog meer pogingen verspillen.
      if (geenAchtereen >= 2) {
        log.log("  Twee keer achter elkaar ziet Gemini geen berichten in de HTML; verder proberen heeft geen zin.");
        break;
      }
      continue;
    }

    if (v.kandidaat.selectors) {
      const st = analyseerSelectors($, v.kandidaat.selectors, url);
      log.log(`  Recept: ${JSON.stringify(v.kandidaat.selectors)}`);
      log.log(`  De itemSelector matcht ${st.matches} element(en) op de pagina: ${st.metTitel} met titel, ${st.metLink} met link, ${st.metFoto} met foto.`);
    } else {
      log.log(`  Voorgesteld: ${v.kandidaat.type} ${v.kandidaat.url}${v.kandidaat.json ? ` ${JSON.stringify(v.kandidaat.json)}` : ""}`);
    }

    // Elke route wordt getest tegen de referentielijst; selector-recepten krijgen ook de pad-controle.
    // totaalGezien gaat mee als waarschuwing (niet als eis) — alleen de URLs in `verwacht` zijn
    // tegen echte links gecontroleerd.
    const extra = {
      verwacht,
      paginaLinks,
      zonderReferentie: verwacht.length === 0,
      totaalGezien,
      ...(v.kandidaat.type === "gemini-recept" ? { padKandidaten } : {}),
    };
    const resultaat = await testKandidaat(v.kandidaat, extra);
    const klaar = verwerk(`gemini-poging-${poging}`, resultaat);
    if (klaar) return { klaar };

    // Een netwerkfout zegt niets over het recept: geen feedback geven en geen pogingen verspillen.
    if (resultaat.oordeel.infra) {
      log.log("  De pagina was tijdens het testen niet bereikbaar. Dat ligt niet aan het recept; verdere pogingen stoppen.");
      break;
    }

    geschiedenis.push(bouwFeedback({ poging, model, v, resultaat, $, url, verwacht, padKandidaten }));
  }
  return { klaar: null };
}

module.exports = {
  geminiAnalyse,
  geminiPad,
  maakSchoneHtml,
  bouwPrompt,
  valideerAntwoord,
  vindKandidaatBlokken,
  bepaalPadKandidaten,
  htmlRondLink,
  leesAntwoord,
  MODELLEN,
  MAX_POGINGEN,
};
