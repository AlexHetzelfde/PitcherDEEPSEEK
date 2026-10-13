// bron-poort.js
//
// De "poort" waar elke nieuwe bron doorheen moet voordat 'ie in bronnen.js
// komt. Dit is de plek waar "gelukt" wordt bewezen, niet aangenomen.
//
// Sinds de "schone tekst"-ronde (2026-10-13): controleerTekst geeft
// bron.detailSelector en b.titel door aan de tekststap, zodat ook nieuwe
// bronnen met een specifieke detail-selector de schone tekst kunnen
// beoordelen.

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

const SELECTOR_TYPES = ["generieke-lijst", "gemini-recept"];

const MIN_DEKKING = 0.85;
const MIN_DATUMDEKKING = 0.5;
const MIN_ZELFDE_SITE = 0.5;
const WEINIG_BERICHTEN = 3;
const MIN_TITEL_TEKENS = 4;
const TEKST_STEEKPROEF = 10;
const MIN_TEKST_TEKENS = 100;
const MIN_TEKST_DEKKING = 0.6;

const PADKANDIDATEN_MIN_AANTAL = 20;
const PADKANDIDATEN_MAX_DEKKING = 0.5;

const GENERIEKE_LINKTEKST = /^(lees\s+(meer|verder)|meer(\s+lezen|\s+info)?|read\s+more|klik\s+hier|bekijk|details?|»|›|>)$/i;

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

async function draaiScraper(bron) {
  const scraper = scraperVoorType(bron.type);
  if (!scraper) throw new Error(`Onbekend brontype "${bron.type}"`);
  return scraper(bron, new Set());
}

function dagSleutel(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function beoordeelResultaat(bron, berichten, opties = {}) {
  const redenen = [];
  const waarschuwingen = [];
  const siteUrl = opties.siteUrl || bron.url;

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

  const eigenDomein = registreerbaarDomein(siteUrl);
  const opEigenSite = geldig.filter((b) => registreerbaarDomein(b.url) === eigenDomein).length;
  if (eigenDomein && opEigenSite / aantal < MIN_ZELFDE_SITE) {
    redenen.push(`Slechts ${opEigenSite} van ${aantal} links blijft op ${eigenDomein}; dit lijken geen berichten van deze bron.`);
  }

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
  statistieken.agendaUitDatums = agendaUitDatums(geldig).reden;

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
    if (SELECTOR_TYPES.includes(bron.type) && !bron.paginering && verwacht.length < 50 && aantal > verwacht.length * 2 + 3) {
      waarschuwingen.push(`Het recept vindt ${aantal} items, Gemini ziet er maar ${verwacht.length}. Mogelijk worden ook menu- of zijbalk-items meegenomen.`);
    }
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

function telBinnenVenster(oordeel, bron) {
  const geldig = oordeel.geldig || [];
  const binnen = geldig.filter((b) => binnenVenster(b.gepubliceerdOp, bron, b.eindDatum)).length;
  const vensterTekst =
    bron.soort === "agenda"
      ? `het agenda-venster (alleen evenementen die vandaag beginnen)`
      : `het leeftijdsvenster (maximaal ${MAX_LEEFTIJD_DAGEN} dagen oud)`;
  return { binnen, totaal: geldig.length, vensterTekst };
}

function kiesSteekproef(lijst, aantal) {
  if (lijst.length <= aantal) return lijst.map((_, i) => i);
  const indexen = new Set();
  for (let i = 0; i < aantal; i++) indexen.add(Math.round((i * (lijst.length - 1)) / (aantal - 1)));
  return [...indexen];
}

function isVerbindingsFout(fout) {
  return isNetwerkFout(fout) && !/HTTP \d{3}/.test(String(fout && fout.message));
}

async function controleerTekst(oordeel, bron, opties = {}) {
  const indexen = kiesSteekproef(oordeel.geldig, TEKST_STEEKPROEF);
  const monsters = indexen.map((i) => ({
    ...oordeel.geldig[i],
    bronId: bron.id,
    ...(bron.detailSelector ? { detailSelector: bron.detailSelector } : {}),
  }));
  let verbindingsFouten = 0;
  const haalTekst = opties.haalTekst || haalArtikelTekst;
  const { perBron } = await vulBerichtenAanMetTekst(monsters, {
    haalTekst: async (url, tekstOpties) => {
      try {
        return await haalTekst(url, tekstOpties);
      } catch (fout) {
        if (isVerbindingsFout(fout)) verbindingsFouten++;
        throw fout;
      }
    },
    log: { warn: () => {} },
    parallel: 1,
    pauzeMs: opties.tekstPauzeMs ?? 300,
  });
  const s = perBron[bron.id] || { totaal: monsters.length, metTekst: 0, metFoto: 0, opgehaald: 0, geenTekst: 0, fouten: 0, overgeslagen: 0 };

  let metTekst = 0;
  monsters.forEach((m, i) => {
    const tekens = (m.samenvatting || "").length;
    oordeel.geldig[indexen[i]].tekstTekens = tekens;
    oordeel.geldig[indexen[i]].foto = m.foto || oordeel.geldig[indexen[i]].foto || null;
    if (tekens >= MIN_TEKST_TEKENS) metTekst++;
  });
  const steekproef = monsters.length;
  const dekking = steekproef ? metTekst / steekproef : 0;
  oordeel.tekstDekking = dekking;
  oordeel.tekstTekst = `${metTekst} van ${steekproef} met tekst (steekproef)`;
  oordeel.statistieken.tekst = { steekproef, metTekst, opgehaald: s.opgehaald, geenTekst: s.geenTekst, fouten: s.fouten, overgeslagen: s.overgeslagen };

  const fotoDekking = steekproef ? s.metFoto / steekproef : 0;
  oordeel.fotoDekking = fotoDekking;
  oordeel.fotoTekst = `${s.metFoto} van ${steekproef} met foto (steekproef)`;
  oordeel.statistieken.foto = { steekproef, metFoto: s.metFoto };
  if (steekproef > 0 && s.metFoto === 0) {
    oordeel.waarschuwingen.push(`Geen enkele foto in de steekproef van ${steekproef} bericht(en). De feed toont voor deze bron dan een grijs vak met een fotootje-icoon; dat is geen fout, maar wel een gemis.`);
  } else if (steekproef > 0 && fotoDekking < 0.5) {
    oordeel.waarschuwingen.push(`Slechts ${s.metFoto} van de ${steekproef} berichten in de steekproef hebben een foto; de rest krijgt een grijs vak in de feed.`);
  }

  if (dekking >= MIN_TEKST_DEKKING) return oordeel;

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

async function testBron(bron, opties = {}) {
  let berichten;
  try {
    berichten = await draaiScraper(bron);
  } catch (fout) {
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
      oordeel.waarschuwingen.push(`De tekstcontrole kon niet worden uitgevoerd (${fout.message}); de tekstdekking is niet bewezen.`);
    }
  }
  return oordeel;
}

function voorbeeldRegels(oordeel, aantal = 3) {
  return oordeel.geldig
    .slice(0, aantal)
    .map((b, i) => {
      const delen = [`datum: ${b.gepubliceerdOp ? String(b.gepubliceerdOp).slice(0, 10) : "geen"}`];
      if (b.tekstTekens !== undefined) delen.push(`tekst: ${b.tekstTekens} tekens`);
      delen.push(`foto: ${b.foto ? "ja" : "nee"}`);
      return `  ${i + 1}. "${b.titel}" (${delen.join(", ")}) ${b.url}`;
    });
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
