// bron-poort.js
//
// De "poort" waar elke nieuwe bron doorheen moet voordat 'ie in bronnen.js
// komt. Dit is de plek waar "gelukt" wordt bewezen, niet aangenomen.
//
// Waarom dit bestaat: voeg-bron-toe.js meldde bij de bron "orkaan" dat het
// gelukt was, terwijl de bron 0 berichten opleverde. Het script had een
// feed-link in de pagina gezien en daar nooit iets mee getest. Nu geldt voor
// ELKE methode (feed, WordPress REST, JSON-LD, generieke patronen, Gemini):
//
//   1. De methode draait via de ECHTE scraper uit de dagelijkse run (dezelfde
//      functie uit scraper-register.js), niet via een eigen testkopie. Wat
//      hier werkt, werkt 's nachts gegarandeerd hetzelfde.
//   2. Het resultaat moet de kwaliteitscontrole halen (titel, unieke link op
//      dezelfde site, leesbare datum die niet overal gelijk is).
//   3. Er is altijd een referentielijst (de berichten die Gemini zelf op de
//      pagina ziet, gecontroleerd tegen echte links). ELKE methode moet die
//      lijst voor minstens MIN_DEKKING terugvinden. Alleen als Gemini geen
//      lijst kon geven, ontbreekt die controle; zo'n uitkomst is dan altijd
//      "twijfel" en komt er alleen in met uitdrukkelijke toestemming.
//   4. Tekst: dezelfde tekststap als de dagelijkse run (haalArtikelTekst in
//      hulpmiddelen.js) draait op een steekproef van TEKST_STEEKPROEF berichten.
//      Levert te weinig daarvan bruikbare tekst (MIN_TEKST_TEKENS tekens, voor
//      minstens MIN_TEKST_DEKKING van de steekproef), dan valt de bron af:
//      Gemini zou dan alleen titels zien en kan het gevolg voor mensen niet beoordelen.
//
// Sinds de "robuust"-ronde:
//   - MIN_DEKKING van 0.8 naar 0.85 (strenger, maar niet zo streng dat
//     kleine afwijkingen door URL-redirects direct afkeuren).
//   - TEKST_STEEKPROEF van 5 naar 10 (minder toeval bij de tekstcontrole).
//   - Padkandidaten: bij 20+ links onder hetzelfde pad en minder dan 50%
//     dekking door het recept volgt een AFKEURING (tenzij het aantal
//     padkandidaten duidelijk groter is dan wat Gemini ziet — dan zijn het
//     waarschijnlijk categorie- en filterlinks).
//   - totaalGezien (indien beschikbaar): Gemini's eigen schatting van het
//     totale aantal berichten op de pagina. Als die veel hoger is dan zijn
//     eigen titellijst, komt er een expliciete waarschuwing.
//   - Datum-diversiteit: 5+ identieke datums keurt af (was 4).
//
// Bewust GEEN vast minimum van "3 berichten": een rustige bron met 2 berichten
// op de pagina mag prima. Dan telt de volledigheid (vindt het recept alles
// wat er staat?) en krijgt de bron in bronnen.js het vlaggetje rustig: true.
//
// De leeftijdsfilter (max 7 dagen) wordt hier bewust NIET toegepast. Een bron
// waar twee weken niets is geplaatst, is geen kapotte bron.

const { scraperVoorType } = require("./scraper-register");
const {
  isNetwerkFout,
  oorzaakTekst,
  vulBerichtenAanMetTekst,
  haalArtikelTekst,
  agendaUitDatums,
  binnenVenster,
  MAX_LEEFTIJD_DAGEN,
  AGENDA_MAX_VERLEDEN_DAGEN,
  AGENDA_MAX_VOORUIT_DAGEN,
} = require("./hulpmiddelen");

// Recept-typen die op HTML-selectors leunen. Daar kan "1 match" toeval zijn,
// dus zonder referentielijst van Gemini eisen we minstens 3 berichten.
const SELECTOR_TYPES = ["generieke-lijst", "gemini-recept"];

const MIN_DEKKING = 0.85; // recept moet minstens 85% van Gemini's lijst terugvinden
const MIN_DATUMDEKKING = 0.5; // minstens de helft van de berichten moet een leesbare datum hebben
const MIN_ZELFDE_SITE = 0.5; // minstens de helft van de links moet op dezelfde site blijven
const WEINIG_BERICHTEN = 3; // onder dit aantal krijgt een geslaagde bron rustig: true
const MIN_TITEL_TEKENS = 4;
const TEKST_STEEKPROEF = 10; // zoveel berichten (gelijk verdeeld over de lijst) gaan door de tekststap
const MIN_TEKST_TEKENS = 100; // korter dan dit telt niet als "met tekst"
const MIN_TEKST_DEKKING = 0.6; // minstens 60% van de steekproef moet bruikbare tekst opleveren (6 van 10)

// Drempels voor de padkandidaten-check: als er zo veel links onder hetzelfde
// pad staan die het recept niet vindt, is er echt iets mis (niet zomaar een
// categorie- of filterlink).
const PADKANDIDATEN_MIN_AANTAL = 20;
const PADKANDIDATEN_MAX_DEKKING = 0.5;

// Linkteksten die geen titel zijn. Als een recept deze als "titel" pakt, heeft
// het de "lees meer"-knop te pakken in plaats van de kop van het bericht.
const GENERIEKE_LINKTEKST = /^(lees\s+(meer|verder)|meer(\s+lezen|\s+info)?|read\s+more|klik\s+hier|bekijk|details?|»|›|>)$/i;

/** Maakt een url vergelijkbaar: geen www, geen #anker, geen slash aan het eind, geen tracking-parameters. */
function normaliseerUrl(url, basis) {
  try {
    const u = new URL(url, basis);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    for (const sleutel of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(sleutel)) u.searchParams.delete(sleutel);
    }
    const pad = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${pad}${u.search}`;
  } catch {
    return null;
  }
}

/** Grove "registreerbaar domein" (zaanstad.nl uit loket.zaanstad.nl), zonder externe lijst. */
function registreerbaarDomein(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().replace(/^www\./, "").split(".");
    if (labels.length <= 2) return labels.join(".");
    const voorlaatste = labels[labels.length - 2];
    const langeTweeLetterEnding = labels[labels.length - 1].length === 2 && ["co", "com", "org", "net", "gov", "ac"].includes(voorlaatste);
    return labels.slice(langeTweeLetterEnding ? -3 : -2).join(".");
  } catch {
    return null;
  }
}

/** Draait de echte scraper voor een bron-config, precies zoals de dagelijkse run dat doet. */
async function draaiScraper(bron) {
  const scraper = scraperVoorType(bron.type);
  if (!scraper) throw new Error(`Onbekend brontype "${bron.type}"`);
  return scraper(bron, new Set());
}

function dagSleutel(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Beoordeelt het resultaat van een scraper-run.
 *
 * opties:
 *   siteUrl     de pagina waar de bron bij hoort (voor de zelfde-site-check)
 *   verwacht    [{ titel, url }] referentielijst van Gemini (al gecontroleerd
 *               tegen de echte links op de pagina); zet de volledigheidscheck aan
 *   totaalGezien  Gemini's eigen schatting van het TOTALE aantal berichten op de
 *               pagina (kan hoger zijn dan verwacht.length). Alleen gebruikt
 *               voor een waarschuwing; de harde volledigheidscheck blijft tegen
 *               verwacht lopen, want alleen die URLs zijn echt gecontroleerd.
 *   zonderReferentie  true als Gemini geen lijst kon geven: de volledigheid is dan
 *               niet te bewijzen, en het resultaat wordt "twijfel"
 *   paginaLinks Set met genormaliseerde links op de pagina; alleen voor
 *               feed/API-kandidaten, om te zien of ze bij deze pagina horen
 *   padKandidaten  genormaliseerde links onder hetzelfde pad als de lijstpagina
 *               (zonder query, zonder paginering); geeft een harde afkeuring
 *               als er veel van zijn die het recept niet vindt
 *
 * Geeft terug: { geslaagd, twijfel, rustig, aantal, redenen, waarschuwingen,
 *                dekking, ontbrekend, geldig, statistieken }
 */
function beoordeelResultaat(bron, berichten, opties = {}) {
  const redenen = [];
  const waarschuwingen = [];
  const siteUrl = opties.siteUrl || bron.url;

  // --- Per bericht: titel + geldige, unieke link ---
  let zonderTitel = 0;
  let zonderLink = 0;
  let dubbel = 0;
  const gezien = new Set();
  const geldig = [];
  for (const b of berichten || []) {
    const titel = (b.titel || "").replace(/\s+/g, " ").trim();
    if (titel.length < MIN_TITEL_TEKENS || GENERIEKE_LINKTEKST.test(titel)) {
      zonderTitel++;
      continue;
    }
    const genormaliseerd = normaliseerUrl(b.url || "");
    if (!genormaliseerd) {
      zonderLink++;
      continue;
    }
    if (gezien.has(genormaliseerd)) {
      dubbel++;
      continue;
    }
    gezien.add(genormaliseerd);
    geldig.push({ ...b, titel });
  }

  const aantal = geldig.length;
  const statistieken = { ruw: (berichten || []).length, geldig: aantal, zonderTitel, zonderLink, dubbel };

  if (aantal === 0) {
    redenen.push(
      `Geen enkel bruikbaar bericht (${statistieken.ruw} ruwe items: ${zonderTitel} zonder echte titel, ${zonderLink} zonder geldige link, ${dubbel} dubbel).`
    );
    return { geslaagd: false, twijfel: false, rustig: false, aantal, redenen, waarschuwingen, dekking: null, ontbrekend: [], geldig, statistieken };
  }
  if (zonderTitel + zonderLink > 0) {
    waarschuwingen.push(`${zonderTitel + zonderLink} van ${statistieken.ruw} items overgeslagen (geen echte titel of geen geldige link).`);
  }

  // --- Zelfde site ---
  const eigenDomein = registreerbaarDomein(siteUrl);
  const opEigenSite = geldig.filter((b) => registreerbaarDomein(b.url) === eigenDomein).length;
  if (eigenDomein && opEigenSite / aantal < MIN_ZELFDE_SITE) {
    redenen.push(`Slechts ${opEigenSite} van ${aantal} links blijft op ${eigenDomein}; dit lijken geen berichten van deze bron.`);
  }

  // --- Datums ---
  const metDatum = geldig.filter((b) => b.gepubliceerdOp && dagSleutel(b.gepubliceerdOp));
  const datumDekking = metDatum.length / aantal;
  statistieken.metDatum = metDatum.length;
  if (datumDekking < MIN_DATUMDEKKING) {
    redenen.push(
      `Slechts ${metDatum.length} van ${aantal} berichten hebben een leesbare datum. De dagelijkse run weert berichten zonder datum als "te oud", dus deze bron zou vrijwel niets opleveren. Staan de datums zonder jaar (zoals "30 sep")? Kies dan soort "agenda" in plaats van "nieuws".`
    );
  } else if (metDatum.length < aantal) {
    waarschuwingen.push(`${aantal - metDatum.length} van ${aantal} berichten hebben geen leesbare datum; die worden 's nachts als "te oud" geweerd.`);
  }
  const uniekeDagen = new Set(metDatum.map((b) => dagSleutel(b.gepubliceerdOp)));
  if (metDatum.length >= 5 && uniekeDagen.size === 1) {
    redenen.push(`Alle ${metDatum.length} berichten hebben dezelfde datum (${[...uniekeDagen][0]}); waarschijnlijk wordt de datum van de pagina gepakt in plaats van die van elk bericht.`);
  } else if (metDatum.length >= 2 && uniekeDagen.size === 1) {
    waarschuwingen.push(`Alle ${metDatum.length} berichten met datum hebben dezelfde dag (${[...uniekeDagen][0]}); controleer of dat klopt.`);
  }
  const nu = Date.now();
  statistieken.toekomst = metDatum.filter((b) => new Date(b.gepubliceerdOp).getTime() > nu + 12 * 3600 * 1000).length;
  // Wat de datums zelf zeggen over het soort bron (zie agendaUitDatums in hulpmiddelen.js).
  statistieken.agendaUitDatums = agendaUitDatums(geldig).reden;

  // --- Volledigheid tegen de referentielijst van Gemini ---
  let dekking = null;
  let ontbrekend = [];
  const verwacht = opties.verwacht || [];
  const totaalGezien = Number.isFinite(opties.totaalGezien) && opties.totaalGezien > 0 ? Math.floor(opties.totaalGezien) : null;
  if (totaalGezien) statistieken.totaalGezien = totaalGezien;

  if (verwacht.length > 0) {
    const gevondenSet = new Set(geldig.map((b) => normaliseerUrl(b.url)));
    const gevonden = verwacht.filter((v) => gevondenSet.has(normaliseerUrl(v.url)));
    ontbrekend = verwacht.filter((v) => !gevondenSet.has(normaliseerUrl(v.url)));
    dekking = gevonden.length / verwacht.length;
    statistieken.verwacht = verwacht.length;
    statistieken.gevondenVanVerwacht = gevonden.length;
    if (dekking < MIN_DEKKING) {
      redenen.push(`Deze methode vindt ${gevonden.length} van de ${verwacht.length} berichten die Gemini op de pagina ziet (minimaal ${Math.round(MIN_DEKKING * 100)}% nodig).`);
    }
    // Alleen voor selector-recepten: een feed of API heeft van nature meer of minder items dan de pagina toont.
    // Met paginering (bron.paginering) staan er bewust meer berichten dan op pagina 1.
    if (SELECTOR_TYPES.includes(bron.type) && !bron.paginering && verwacht.length < 50 && aantal > verwacht.length * 2 + 3) {
      waarschuwingen.push(`Het recept vindt ${aantal} items, Gemini ziet er maar ${verwacht.length}. Mogelijk worden ook menu- of zijbalk-items meegenomen.`);
    }
    // Padkandidaten: veel links onder hetzelfde pad die het recept niet vindt.
    // Alleen streng als het aantal padkandidaten niet duidelijk groter is dan
    // wat Gemini ziet (in dat geval zitten er waarschijnlijk categorie- en
    // filterlinks tussen, en is een lage dekking normaal).
    const padKandidaten = opties.padKandidaten || [];
    if (padKandidaten.length >= 6) {
      const padGevonden = padKandidaten.filter((u) => gevondenSet.has(u)).length;
      const dekkingPad = padGevonden / padKandidaten.length;
      statistieken.padKandidaten = padKandidaten.length;
      statistieken.padDekking = dekkingPad;
      const padLijktOpBerichten = padKandidaten.length <= verwacht.length * 1.5 + 3;
      if (dekkingPad < PADKANDIDATEN_MAX_DEKKING && padKandidaten.length >= PADKANDIDATEN_MIN_AANTAL && padLijktOpBerichten) {
        redenen.push(
          `Het recept vindt maar ${padGevonden} van de ${padKandidaten.length} links onder hetzelfde pad als de lijstpagina (${Math.round(dekkingPad * 100)}%). Dat zijn er bijna net zoveel als Gemini ziet, dus dit lijken echte berichtlinks: het recept mist waarschijnlijk een groot deel van de lijst.`
        );
      } else if (dekkingPad < PADKANDIDATEN_MAX_DEKKING) {
        waarschuwingen.push(
          `Op de pagina staan ${padKandidaten.length} links onder hetzelfde pad, het recept vindt er ${padGevonden}. Mogelijk mist het recept een deel van de lijst (of het zijn categorie- en filterlinks).`
        );
      }
    }
    // totaalGezien: als Gemini zelf zegt dat er veel meer berichten op de
    // pagina staan dan hij in zijn lijst noemde, weten we dat het recept
    // alleen tegen die (kleinere) lijst is getest. Geen afkeuring — Gemini's
    // titellijst is de enige referentie die we echt tegen echte links hebben
    // gecontroleerd — maar wel een expliciete waarschuwing.
    if (totaalGezien && totaalGezien > verwacht.length * 1.5) {
      waarschuwingen.push(
        `Gemini zegt ${totaalGezien} berichten op de pagina te zien, maar noemde er ${verwacht.length} bij naam. Het recept is getest tegen die ${verwacht.length}; of het de andere ${totaalGezien - verwacht.length} ook vindt, is niet bewezen.`
      );
    }
  } else if (SELECTOR_TYPES.includes(bron.type) && aantal < WEINIG_BERICHTEN) {
    redenen.push(
      `Een selector-recept dat maar ${aantal} bericht(en) vindt, kan zonder referentielijst van Gemini niet gecontroleerd worden (toeval is dan niet uit te sluiten).`
    );
  }

  // --- Hoort dit bij de pagina? (feed / API / JSON-LD) ---
  // Alleen nodig zonder referentielijst; mét lijst is de dekking hierboven het bewijs.
  let twijfel = false;
  if (opties.zonderReferentie && verwacht.length === 0) {
    twijfel = true;
    waarschuwingen.push(
      `Gemini gaf geen lijst van berichten op de pagina (bijvoorbeeld omdat de berichten met JavaScript worden geladen). Daardoor is niet bewezen dat deze methode alle berichten vindt.`
    );
  }
  if (opties.paginaLinks && verwacht.length === 0) {
    const opPagina = geldig.filter((b) => opties.paginaLinks.has(normaliseerUrl(b.url))).length;
    statistieken.opPagina = opPagina;
    if (opPagina === 0) {
      twijfel = true;
      waarschuwingen.push(
        `Geen enkel bericht uit deze bron staat als link op de opgegeven pagina. Het kan een feed of API zijn die niet bij deze pagina hoort (bijvoorbeeld een algemene blog-feed naast een agenda).`
      );
    }
  }

  const geslaagd = redenen.length === 0;
  const rustig = geslaagd && aantal < WEINIG_BERICHTEN;
  if (rustig) waarschuwingen.push(`Slechts ${aantal} bericht(en) gevonden; de bron krijgt rustig: true zodat de dagelijkse run dit niet als fout meldt.`);

  return { geslaagd, twijfel: geslaagd && twijfel, rustig, aantal, redenen, waarschuwingen, dekking, ontbrekend, geldig, statistieken };
}

/**
 * Telt hoeveel van de bewezen berichten binnen het venster van de bron vallen: het
 * leeftijdsvenster voor nieuws, het agenda-venster voor een agenda (inclusief
 * einddatum bij meerdaagse evenementen). Hetzelfde filter als de dagelijkse run.
 * Geeft { binnen, totaal, vensterTekst }.
 */
function telBinnenVenster(oordeel, bron) {
  const geldig = oordeel.geldig || [];
  const binnen = geldig.filter((b) => binnenVenster(b.gepubliceerdOp, bron, b.eindDatum)).length;
  const vensterTekst =
    bron.soort === "agenda"
      ? `het agenda-venster (alleen evenementen die vandaag beginnen)`
      : `het leeftijdsvenster (maximaal ${MAX_LEEFTIJD_DAGEN} dagen oud)`;
  return { binnen, totaal: geldig.length, vensterTekst };
}

/** Kiest `aantal` berichten, gelijk verdeeld over de lijst (altijd het eerste en het laatste erbij). */
function kiesSteekproef(lijst, aantal) {
  if (lijst.length <= aantal) return lijst.map((_, i) => i);
  const indexen = new Set();
  for (let i = 0; i < aantal; i++) indexen.add(Math.round((i * (lijst.length - 1)) / (aantal - 1)));
  return [...indexen];
}

/** Een fout van de verbinding zelf (time-out, geweigerd), geen HTTP-statuscode: zegt niets over de bron. */
function isVerbindingsFout(fout) {
  return isNetwerkFout(fout) && !/HTTP \d{3}/.test(String(fout && fout.message));
}

/**
 * Draait de tekststap op een steekproef van de geldige berichten en past het
 * oordeel aan: bij te weinig bruikbare tekst valt de bron af. Alleen aanroepen
 * voor een oordeel dat al geslaagd is. Mislukt de steekproef helemaal door
 * verbindingsfouten, dan is dat een infra-probleem en geen kwaliteit van de bron.
 *
 * Voegt toe aan het oordeel: tekstDekking (aandeel 0-1), tekstTekst
 * ("8 van 10 met tekst"), statistieken.tekst, en tekstTekens op de gebruikte
 * berichten in oordeel.geldig (voor de voorbeeldregels).
 */
async function controleerTekst(oordeel, bron, opties = {}) {
  const indexen = kiesSteekproef(oordeel.geldig, TEKST_STEEKPROEF);
  const monsters = indexen.map((i) => ({ ...oordeel.geldig[i], bronId: bron.id }));
  let verbindingsFouten = 0;
  const haalTekst = opties.haalTekst || haalArtikelTekst;
  const { perBron } = await vulBerichtenAanMetTekst(monsters, {
    haalTekst: async (url) => {
      try {
        return await haalTekst(url);
      } catch (fout) {
        if (isVerbindingsFout(fout)) verbindingsFouten++;
        throw fout;
      }
    },
    log: { warn: () => {} }, // de mislukkingen komen in het oordeel, niet als losse logregels
    parallel: 1,
    pauzeMs: opties.tekstPauzeMs ?? 300,
  });
  const s = perBron[bron.id] || { totaal: monsters.length, metTekst: 0, opgehaald: 0, geenTekst: 0, fouten: 0, overgeslagen: 0 };

  let metTekst = 0;
  monsters.forEach((m, i) => {
    const tekens = (m.samenvatting || "").length;
    oordeel.geldig[indexen[i]].tekstTekens = tekens;
    if (tekens >= MIN_TEKST_TEKENS) metTekst++;
  });
  const steekproef = monsters.length;
  const dekking = steekproef ? metTekst / steekproef : 0;
  oordeel.tekstDekking = dekking;
  oordeel.tekstTekst = `${metTekst} van ${steekproef} met tekst (steekproef)`;
  oordeel.statistieken.tekst = { steekproef, metTekst, opgehaald: s.opgehaald, geenTekst: s.geenTekst, fouten: s.fouten, overgeslagen: s.overgeslagen };

  if (dekking >= MIN_TEKST_DEKKING) return oordeel;

  // Alles faalde door de verbinding: dat zegt niets over de bron zelf. De tekststap slaat na drie
  // verbindingsfouten achter elkaar de rest van een site over; die overgeslagen berichten tellen hier mee.
  if (steekproef > 0 && verbindingsFouten > 0 && verbindingsFouten + s.overgeslagen >= steekproef) {
    oordeel.infra = true;
    oordeel.geslaagd = false;
    oordeel.twijfel = false;
    oordeel.rustig = false;
    oordeel.redenen.push(`De berichtpagina's waren tijdens het testen niet bereikbaar (${verbindingsFouten} verbindingsfout(en), ${s.overgeslagen} overgeslagen, van ${steekproef} in de steekproef), dus de tekst kon niet worden beoordeeld. Dit zegt niets over de bron zelf.`);
    return oordeel;
  }

  const details = [];
  if (s.geenTekst) details.push(`${s.geenTekst} pagina('s) zonder bruikbare tekst (bijvoorbeeld met JavaScript opgebouwd of een pdf)`);
  if (s.fouten) details.push(`${s.fouten} niet op te halen`);
  oordeel.geslaagd = false;
  oordeel.twijfel = false;
  oordeel.rustig = false;
  oordeel.redenen.push(
    `Te weinig berichten leveren bruikbare tekst op: ${oordeel.tekstTekst}, minimaal ${Math.round(MIN_TEKST_DEKKING * 100)}% met ${MIN_TEKST_TEKENS} tekens of meer nodig${details.length ? ` (${details.join(", ")})` : ""}. Gemini zou van deze bron vooral titels zien en kan het gevolg voor mensen dan niet beoordelen.`
  );
  return oordeel;
}

/** Draait de echte scraper en beoordeelt de uitkomst. Vangt scraper-fouten op als afkeurreden. */
async function testBron(bron, opties = {}) {
  let berichten;
  try {
    berichten = await draaiScraper(bron);
  } catch (fout) {
    // Een netwerkfout zegt niets over het recept. Zo markeren dat de aanroeper niet de
    // schuld bij het recept legt (en Gemini er geen misleidende feedback over krijgt).
    const infra = isNetwerkFout(fout);
    return {
      geslaagd: false,
      infra,
      twijfel: false,
      rustig: false,
      aantal: 0,
      redenen: [
        infra
          ? `De pagina was tijdens het testen niet bereikbaar (${fout.message}${oorzaakTekst(fout)}). Dit zegt niets over het recept zelf.`
          : `De scraper zelf gaf een fout: ${fout.message}`,
      ],
      waarschuwingen: [],
      dekking: null,
      ontbrekend: [],
      geldig: [],
      statistieken: { ruw: 0, geldig: 0 },
    };
  }
  const oordeel = beoordeelResultaat(bron, berichten, opties);
  if (oordeel.geslaagd && !opties.zonderTekstControle) {
    try {
      await controleerTekst(oordeel, bron, opties);
    } catch (fout) {
      // De tekstcontrole zelf is stukgegaan: nooit stil. Het oordeel blijft staan, met een waarschuwing.
      oordeel.waarschuwingen.push(`De tekstcontrole kon niet worden uitgevoerd (${fout.message}); de tekstdekking is niet bewezen.`);
    }
  }
  return oordeel;
}

/** Korte, controleerbare voorproef voor in de log: de eerste berichten met hun datum. */
function voorbeeldRegels(oordeel, aantal = 3) {
  return oordeel.geldig
    .slice(0, aantal)
    .map((b, i) => `  ${i + 1}. "${b.titel}" (datum: ${b.gepubliceerdOp ? String(b.gepubliceerdOp).slice(0, 10) : "geen"}${b.tekstTekens !== undefined ? `, tekst: ${b.tekstTekens} tekens` : ""}) ${b.url}`);
}

module.exports = {
  normaliseerUrl,
  registreerbaarDomein,
  draaiScraper,
  beoordeelResultaat,
  testBron,
  controleerTekst,
  telBinnenVenster,
  voorbeeldRegels,
  MIN_DEKKING,
  TEKST_STEEKPROEF,
  MIN_TEKST_TEKENS,
  MIN_TEKST_DEKKING,
  WEINIG_BERICHTEN,
  SELECTOR_TYPES,
};
