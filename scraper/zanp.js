// zanp.js — ingang van de half-uurlijkse nieuwsdienst-run (ZANP)
//
// Draait los van de pitchmachine (index.js). Schrijft ALLEEN:
//   data/berichten.json    de nieuwsstroom
//   data/agenda.json       de weekagenda
//   data/zanp-status.json  per bron laatste scrape, dagteller Gemini, enz.
// Leest verder alleen bronnen.js, rubrieken.json en (bij de allereerste run,
// voor de startvulling) data/feed.json. De pitch-bestanden blijven van
// index.js.
//
// Sinds 2026-10-26 (ZANP-fase 2):
//  - ZANP draait op gemini-flash-lite-latest (ruim quotum).
//  - Stroomonderbreker: bij een 429 slaat ZANP de AI over tot de wachttijd
//    verstreken is (opgeslagen in zanp-status.json).
//  - Teller telt alleen geslaagde aanroepen (melding of onvoldoende).
//  - Scrapen parallel (4 tegelijk) met een harde time-out van 45s per bron.
//  - Agenda-horizon: 14 dagen vooruit via maxVooruitDagen op de effectieve
//    bron. De pitchrun (index.js) houdt de oude horizon.
//
// Sinds 2026-10-29:
//  - Het quotum telt VERZOEKEN. De AI werkt in batches van meerdere berichten
//    per verzoek; ZANP_DAGCAP en ZANP_RUNCAP zijn dus aantallen verzoeken.
//  - De quotumdag loopt volgens de Amerikaanse westkust (middernacht Pacific),
//    zoals Google tellt, en niet volgens de Nederlandse kalenderdag.
//  - Belangrijke berichten (signaal- en officiële bronnen, prio 3 of hoger)
//    komen eerst aan bod; routine alleen als er ruimte over is.
//  - Een bron die steeds niets oplevert wordt minder vaak gescrapet.
//  - Berichten krijgen een tag (de kolom); oude records worden eenmalig omgezet.
//  - Berichten en agendapunten worden gekoppeld op harde sleutels (koppel.js).
//  - zanp-status.json bewaart een kwaliteitslog per dag (14 dagen).

const bronnen = require("./bronnen");
const { RUBRIEKEN, isBekendeBron, profielVoor } = require("./rubrieken");
const { tagsVoorPrompt } = require("./tags");
const { koppelDossiers } = require("./koppel");
const {
  binnenVenster,
  vulBerichtenAanMetTekst,
  oorzaakTekst,
  kalenderdagAmsterdam,
} = require("./hulpmiddelen");
const gedeeld = require("./gedeeld");
const wire = require("./wire");
const { REGEL_VERSIE, beoordeelAgendaRelevantie } = require("./agenda-regels");
const { bouwClusters, pasClustersToe, clusterContext, kiesPrimair } = require("./cluster");
const { CONFIG: ALERT_CONFIG, beoordeelAlert, beperkAlerts } = require("./alert-regels");
const {
  schrijfMeldingen,
  beslisZelfdeNieuwsfeit,
  PROMPT_VERSIE_WIRE,
  BATCH_GROOTTE,
  ZELFDE_PER_VERZOEK,
} = require("./gemini");

const { logFase, logDuur, schrijfJson, leesJson } = gedeeld;

const UUR_MS = 3600 * 1000;
const INTERVAL_DAG_MS = 20 * UUR_MS;
const INTERVAL_SNEL_MS = 25 * 60 * 1000;
// Een bron die LEEG_VANAF keer achter elkaar niets opleverde, komt steeds
// minder vaak aan de beurt (x2, x4, x8), hooguit elke INTERVAL_MAX_LEEG_MS.
const LEEG_VANAF = 3;
const INTERVAL_MAX_LEEG_MS = 6 * UUR_MS;
const KWALITEIT_DAGEN = 14;
const HERKOMST_RANG = { officieel: 0, organisatie: 1, signaal: 2, onbekend: 3 };
const ALERT_VENSTER_UREN = 48;

const AGENDA_MAX_VOORUIT_DAGEN_ZANP = 14;
const SCRAPE_PARALLEL = 4;
const SCRAPE_TIMEOUT_MS = 45_000;

function getal(naam, standaard, env) {
  if (env[naam] === undefined || String(env[naam]).trim() === "") return standaard;
  const v = Number(env[naam]);
  return Number.isFinite(v) && v >= 0 ? v : standaard;
}

function leesInstellingen(env) {
  return {
    dagcap: getal("ZANP_DAGCAP", 80, env),
    runcap: getal("ZANP_RUNCAP", 25, env),
    clusterCap: getal("ZANP_CLUSTER_CAP", 8, env),
    tekstMax: getal("ZANP_TEKST_MAX", 60, env),
    agendaDetailMax: getal("AGENDA_DETAIL_MAX", 40, env),
    versieControleUren: getal("VERSIE_CONTROLE_UREN", 2, env),
    alertModus: env.ALERT_MODUS === "aan" ? "aan" : "log",
    alles: env.ZANP_ALLES === "1" || env.ZANP_ALLES === "true",
  };
}

function leegStatus() {
  return {
    bronnen: {},
    gemini: { dag: null, gebruikt: 0, wachtTot: null },
    clusterBeslissingen: {},
    kwaliteit: {},
  };
}

async function leesStatus() {
  const s = await leesJson("zanp-status.json", null);
  if (!s || typeof s !== "object") return leegStatus();
  return {
    ...leegStatus(),
    ...s,
    bronnen: s.bronnen && typeof s.bronnen === "object" ? s.bronnen : {},
    gemini:
      s.gemini && typeof s.gemini === "object" ? s.gemini : { dag: null, gebruikt: 0, wachtTot: null },
    clusterBeslissingen:
      s.clusterBeslissingen && typeof s.clusterBeslissingen === "object" ? s.clusterBeslissingen : {},
    kwaliteit: s.kwaliteit && typeof s.kwaliteit === "object" ? s.kwaliteit : {},
  };
}

// Hoe vaak een bron aan de beurt komt. Rustige bronnen en agendabronnen één
// keer per dag, de rest elke run. Levert een bron steeds niets op, dan wordt
// het interval langer, zodat een kapotte of trage bron niet elke run tijd kost.
function bronInterval(bron, s) {
  const basis = bron.soort === "agenda" || bron.rustig ? INTERVAL_DAG_MS : INTERVAL_SNEL_MS;
  const leeg = (s && s.opeenvolgendLeeg) || 0;
  if (leeg < LEEG_VANAF) return basis;
  const factor = 2 ** (leeg - LEEG_VANAF + 1);
  return Math.min(basis * factor, Math.max(basis, INTERVAL_MAX_LEEG_MS));
}

function isAanDeBeurt(bron, status, nu, alles) {
  if (alles) return true;
  const s = status.bronnen[bron.id];
  if (!s || !s.laatsteScrape) return true;
  // Een kleine marge: een run die om :37 begint mag een bron van :07 oppakken.
  return nu.getTime() - new Date(s.laatsteScrape).getTime() >= bronInterval(bron, s) - 2 * 60 * 1000;
}

function uurNa(iso, uren) {
  return new Date(new Date(iso).getTime() + uren * UUR_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Quotum
// ---------------------------------------------------------------------------

// Google telt een quotumdag van middernacht tot middernacht aan de Amerikaanse
// westkust (Pacific). De dagteller volgt dus die kalenderdag.
const QUOTUM_TZ = "America/Los_Angeles";

function quotumDag(nu) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: QUOTUM_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nu);
}

// Het eerstvolgende moment waarop de quotumdag wisselt (ISO), op de minuut nauwkeurig.
function volgendeQuotumReset(nu) {
  const dag = quotumDag(nu);
  for (let minuten = 15; minuten <= 26 * 60; minuten += 15) {
    const t = new Date(nu.getTime() + minuten * 60 * 1000);
    if (quotumDag(t) !== dag) {
      const t0 = new Date(t.getTime() - 15 * 60 * 1000);
      for (let m = 1; m <= 15; m++) {
        const k = new Date(t0.getTime() + m * 60 * 1000);
        if (quotumDag(k) !== dag) return k.toISOString();
      }
      return t.toISOString();
    }
  }
  return new Date(nu.getTime() + 12 * UUR_MS).toISOString();
}

/**
 * Tot wanneer wachten we na een 429? Gaat het om een dagquotum, dan tot de
 * volgende quotumdag. Noemt de melding een wachttijd ("retry in 1h2m3s"), dan
 * die tijd. Anders een uur.
 */
function wachtTotNaQuotum(foutTekst, nu) {
  const tekst = String(foutTekst || "");
  if (/per\s*day|perday|daily/i.test(tekst)) return volgendeQuotumReset(nu);
  const m = tekst.match(/retry in\s+((?:\d+(?:\.\d+)?\s*[hms]\s*)+)/i);
  if (m) {
    const uren = Number((m[1].match(/(\d+(?:\.\d+)?)\s*h/i) || [])[1] || 0);
    const minuten = Number((m[1].match(/(\d+(?:\.\d+)?)\s*m/i) || [])[1] || 0);
    const seconden = Number((m[1].match(/(\d+(?:\.\d+)?)\s*s/i) || [])[1] || 0);
    const totaalMs = ((uren * 60 + minuten) * 60 + seconden) * 1000;
    if (totaalMs > 0) return new Date(nu.getTime() + totaalMs + 60 * 1000).toISOString();
  }
  return new Date(nu.getTime() + UUR_MS).toISOString();
}

const NIVEAU_RANG = { rood: 0, oranje: 1 };
const CATEGORIE_RANG = { veiligheid: 0, bestuur: 1, economie: 2 };

function bepaalAlerts(records, clusterResultaat, modus, nu) {
  const context = clusterContext(records, clusterResultaat.clusterVan, clusterResultaat.clusters);
  const grens = nu.getTime() - ALERT_VENSTER_UREN * UUR_MS;

  const nieuwste = new Map();
  for (const r of records) {
    const v = nieuwste.get(r.groepId);
    if (!v || (r.versie || 1) > (v.versie || 1)) nieuwste.set(r.groepId, r);
  }
  const recent = [...nieuwste.values()].filter((r) => new Date(r.tijd).getTime() >= grens);

  const perCluster = new Map();
  for (const r of recent) {
    const sleutel = r.clusterId || r.groepId;
    if (!perCluster.has(sleutel)) perCluster.set(sleutel, []);
    perCluster.get(sleutel).push(r);
  }

  const toewijzing = new Map();
  const voorBeperking = [];
  for (const [sleutel, leden] of perCluster) {
    const ctx = context.get(sleutel) || {
      aantalBronnen: 1,
      heeftOfficieleBron: leden[0].herkomst === "officieel",
    };
    let beste = null;
    for (const lid of leden) {
      const a = beoordeelAlert(lid, ctx, { nu });
      if (!a) continue;
      if (
        !beste ||
        NIVEAU_RANG[a.niveau] < NIVEAU_RANG[beste.alert.niveau] ||
        (NIVEAU_RANG[a.niveau] === NIVEAU_RANG[beste.alert.niveau] &&
          CATEGORIE_RANG[a.categorie] < CATEGORIE_RANG[beste.alert.categorie])
      ) {
        beste = { lid, alert: a };
      }
    }
    if (!beste) continue;

    const eerder = leden
      .map((l) => l.alert || l.alertKandidaat)
      .find((e) => e && e.categorie === beste.alert.categorie);
    if (eerder && eerder.aangemaaktOp) {
      beste.alert.aangemaaktOp = eerder.aangemaaktOp;
      beste.alert.tot = uurNa(eerder.aangemaaktOp, ALERT_CONFIG.duurUren[beste.alert.categorie] || 12);
    }
    const houder = leden.length > 1 ? kiesPrimair(leden) : leden[0];
    voorBeperking.push({ id: houder.id, alert: beste.alert });
  }

  for (const [id, alert] of beperkAlerts(voorBeperking, { nu })) toewijzing.set(id, alert);

  return records.map((r) => {
    const alert = toewijzing.get(r.id);
    const { alert: oudAlert, alertKandidaat: oudKandidaat, ...rest } = r;
    void oudAlert;
    void oudKandidaat;
    if (!alert) return rest;
    return modus === "aan" ? { ...rest, alert } : { ...rest, alertKandidaat: alert };
  });
}

// Oude records (van vóór de tags) hebben een oude rubriekcode en geen tagBron.
// Ze krijgen eenmalig een tag op trefwoorden of de standaardtag van hun bron,
// zodat ze meteen in de goede kolom staan.
function migreerTag(r) {
  if (r.tagBron !== undefined) return r;
  const tag = wire.kiesTag({
    kop: r.bronTitel || r.kop,
    tekst: r.tekst || "",
    standaard: profielVoor(r.bronId).rubriek,
  });
  return { ...r, rubriek: tag.tag, tagBron: tag.bron };
}

function migreerBericht(r) {
  let uit = r;
  if (!(r.herkomst && !("soort" in r) && r.gecontroleerdOp)) {
    const { soort, ...rest } = r;
    const profiel = profielVoor(r.bronId);
    uit = {
      ...rest,
      herkomst: r.herkomst || (isBekendeBron(r.bronId) ? profiel.herkomst : soort) || "onbekend",
      gecontroleerdOp: r.gecontroleerdOp || r.eerstGezienOp,
    };
  }
  return migreerTag(uit);
}

function migreerAgendaItem(i) {
  // Een oude rubriekcode (van vóór de tags) wordt de standaardtag van de bron.
  const heeftGeldigeTag = wire.TAG_CODES.includes(i.rubriek) || i.rubriek === "ALG";
  const basis = heeftGeldigeTag ? i : { ...i, rubriek: profielVoor(i.bronId).rubriek };
  if (basis.relevantie !== undefined) return basis.afkomst ? basis : { ...basis, afkomst: "bron" };
  const filter = profielVoor(basis.bronId).agendaFilter;
  if (filter === "eerste-of-jubileum") {
    return { ...basis, afkomst: basis.afkomst || "bron", zichtbaar: false, inAfwachting: true };
  }
  return {
    ...basis,
    afkomst: basis.afkomst || "bron",
    relevantie: beoordeelAgendaRelevantie(basis.kop, "", "alles"),
    zichtbaar: true,
    inAfwachting: false,
  };
}

async function draai(deps = {}) {
  const startRun = Date.now();
  const nu = deps.nu || new Date();
  const env = deps.env || process.env;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : process.env.GEMINI_API_KEY;
  const scrape = deps.scrape || gedeeld.scrapeAlleBronnen;
  const haalTekst = deps.haalTekst || vulBerichtenAanMetTekst;
  const schrijf = deps.schrijf || schrijfMeldingen;
  const beslisZelfde = deps.beslisZelfde || beslisZelfdeNieuwsfeit;
  const inst = leesInstellingen(env);
  const samenvatting = { agenda: null, berichten: null, cluster: null, alerts: 0 };

  logFase("ZANP 1 — Bronnen kiezen");
  const status = await leesStatus();
  const quotaDag = quotumDag(nu);
  if (status.gemini.dag !== quotaDag) {
    // Nieuwe quotumdag: de teller begint opnieuw. Een wachttijd die nog loopt
    // (bijvoorbeeld tot de reset) blijft gelden.
    const wachtTot = status.gemini.wachtTot && new Date(status.gemini.wachtTot) > nu ? status.gemini.wachtTot : null;
    status.gemini = { dag: quotaDag, gebruikt: 0, wachtTot };
  }

  const regionaal = bronnen.filter((b) => b.categorie !== "landelijk");
  const teScrapen = regionaal.filter((b) => isAanDeBeurt(b, status, nu, inst.alles));
  console.log(
    `${teScrapen.length} van ${regionaal.length} regionale bronnen aan de beurt` +
      `${
        bronnen.length > regionaal.length
          ? ` (${bronnen.length - regionaal.length} landelijke bron(nen) doen niet mee)`
          : ""
      }.`
  );
  const zonderRubriek = bronnen.filter((b) => !isBekendeBron(b.id)).map((b) => b.id);
  for (const id of zonderRubriek) {
    console.warn(
      `[${id}] Staat niet in rubrieken.json: rubriek Overig, geen AI-tekst, agendafilter uit. Voeg de bron daar toe.`
    );
  }

  logFase("ZANP 2 — Scrapen");
  const startScrapen = Date.now();

  const teScrapenEffectief = teScrapen.map((b) => {
    const effectief = { ...gedeeld.effectieveBron(b) };
    if (effectief.soort === "agenda") effectief.maxVooruitDagen = AGENDA_MAX_VOORUIT_DAGEN_ZANP;
    return effectief;
  });

  const ruwe = teScrapen.length
    ? await scrape(teScrapenEffectief, { parallel: SCRAPE_PARALLEL, timeoutMs: SCRAPE_TIMEOUT_MS })
    : [];
  logDuur(startScrapen, `Scrapen van ${teScrapen.length} bronnen`);

  const bronPerId = Object.fromEntries(
    bronnen.map((b) => {
      const effectief = { ...gedeeld.effectieveBron(b) };
      if (effectief.soort === "agenda") effectief.maxVooruitDagen = AGENDA_MAX_VOORUIT_DAGEN_ZANP;
      return [b.id, effectief];
    })
  );

  const gevondenPerBron = {};
  for (const b of ruwe) gevondenPerBron[b.bronId] = (gevondenPerBron[b.bronId] || 0) + 1;
  for (const bron of teScrapen) {
    const vorig = status.bronnen[bron.id] || {};
    const gevonden = gevondenPerBron[bron.id] || 0;
    status.bronnen[bron.id] = {
      laatsteScrape: nu.toISOString(),
      gevonden,
      opeenvolgendLeeg: gevonden === 0 ? (vorig.opeenvolgendLeeg || 0) + 1 : 0,
    };
  }

  const opties = {
    nietOphalen: (b) =>
      gedeeld.GEEN_TEKSTOPHAAL_TYPES.has(bronPerId[b.bronId] && bronPerId[b.bronId].type) ||
      gedeeld.GEEN_TEKSTOPHAAL_BRONNEN.has(b.bronId),
    detailSelectorVoor: (b) => {
      const bron = bronPerId[b.bronId];
      return bron && bron.detailSelector ? bron.detailSelector : null;
    },
  };

  logFase("ZANP 3 — Agenda: detailtekst voor het filter");
  const agendaBestand = await leesJson("agenda.json", { items: [] });
  const bestaandeAgenda = (Array.isArray(agendaBestand.items) ? agendaBestand.items : []).map(
    migreerAgendaItem
  );
  const teVerrijkenAgenda = wire.agendaTeVerrijken({
    ruweBerichten: ruwe,
    bronPerId,
    bestaand: bestaandeAgenda,
    max: inst.agendaDetailMax,
    nu,
  });
  console.log(
    `${teVerrijkenAgenda.length} agenda-item(s) krijgen een detailpagina-controle (max ${inst.agendaDetailMax}).`
  );
  if (teVerrijkenAgenda.length) {
    try {
      await haalTekst(teVerrijkenAgenda, opties);
    } catch (fout) {
      console.error(
        `Detailtekst voor de agenda ophalen mislukte (de items worden beoordeeld op de lijsttekst): ${
          fout.message
        }${oorzaakTekst(fout)}`
      );
    }
    for (const b of teVerrijkenAgenda) b._verrijkt = true;
  }

  logFase("ZANP 4 — Nieuws: nieuwe en gewijzigde berichten");
  const berichtenBestand = await leesJson("berichten.json", { berichten: [] });
  const bestaand = (Array.isArray(berichtenBestand.berichten) ? berichtenBestand.berichten : []).map(
    migreerBericht
  );
  const laatstePerUrl = new Map();
  for (const r of bestaand) {
    const v = laatstePerUrl.get(r.url);
    if (!v || (r.versie || 1) > (v.versie || 1)) laatstePerUrl.set(r.url, r);
  }

  const binnen = (b) => {
    const maxVooruit = bronPerId[b.bronId]?.soort === "agenda" ? AGENDA_MAX_VOORUIT_DAGEN_ZANP : 0;
    return binnenVenster(b.gepubliceerdOp, bronPerId[b.bronId], b.eindDatum, maxVooruit);
  };
  const nieuwsRuw = gedeeld
    .verwijderDubbelen(ruwe)
    .filter((b) => !gedeeld.isAgendaItem(b) && binnen(b) && gedeeld.nietInToekomst(b.gepubliceerdOp));

  const teTekst = [];
  for (const b of nieuwsRuw) {
    const vorige = laatstePerUrl.get(b.url);
    if (!vorige) {
      teTekst.push(b);
      continue;
    }
    const jong = nu.getTime() - new Date(vorige.eerstGezienOp).getTime() < 24 * UUR_MS;
    const lang =
      nu.getTime() - new Date(vorige.gecontroleerdOp || vorige.eerstGezienOp).getTime() >=
      inst.versieControleUren * UUR_MS;
    const mislukt =
      !vorige.seed &&
      (vorige.controle === null || vorige.controle === "ai-fout") &&
      !vorige.ai &&
      !vorige.analyse;
    if ((jong && lang) || mislukt) teTekst.push(b);
  }
  const teTekstGekapt = teTekst.slice(0, inst.tekstMax);
  console.log(
    `${nieuwsRuw.length} berichten in het venster; tekst nodig voor ${teTekstGekapt.length}${
      teTekst.length > teTekstGekapt.length ? ` (van ${teTekst.length}, de rest volgt)` : ""
    }.`
  );
  if (teTekstGekapt.length) {
    try {
      await haalTekst(teTekstGekapt, opties);
    } catch (fout) {
      console.error(
        `Tekst ophalen mislukte onverwacht (de berichten gaan door met de lijstgegevens): ${
          fout.message
        }${oorzaakTekst(fout)}`
      );
    }
  }

  const feedItems = await leesJson("feed.json", []);
  const {
    nieuwe,
    bijgewerkteControle,
    stats: planStats,
  } = wire.planBerichten({
    vensterBerichten: teTekstGekapt,
    feedItems: Array.isArray(feedItems) ? feedItems : [],
    bestaand,
    nu,
  });
  console.log(
    `Berichten: ${planStats.nieuw} nieuw, ${planStats.update} nieuwe versie(s), ${
      planStats.opnieuw
    } opnieuw voor AI, ` +
      `${planStats.ongewijzigd} ongewijzigd${
        bestaand.length === 0 ? `, ${planStats.seed} kale signalen uit de feed (eerste run)` : ""
      }.`
  );
  samenvatting.berichten = planStats;

  logFase("ZANP 5 — Meldingen en analyses");
  let verwerkt = nieuwe.map((n) => n.record);
  const run = { verzoeken: 0 };
  let kwaliteitRun = null;

  if (status.gemini.wachtTot && new Date(status.gemini.wachtTot) > nu) {
    console.warn(
      `AI overgeslagen: quotum bereikt, wacht tot ${status.gemini.wachtTot}. De berichten houden hun tag en checklist uit trefwoorden en patronen.`
    );
  } else {
    // Belangrijke berichten eerst; routine alleen als er ruimte over is.
    const wacht = wire.sorteerVoorAI(nieuwe.filter((n) => n.invoer));
    const dagRuimte = Math.max(0, inst.dagcap - status.gemini.gebruikt);
    const cap = Math.min(inst.runcap, dagRuimte); // aantal VERZOEKEN

    if (!apiKey) {
      if (wacht.length) console.log(`Geen API-sleutel: ${wacht.length} bericht(en) blijven kop + link (tag en checklist uit trefwoorden).`);
    } else if (wacht.length === 0) {
      console.log("Niets te schrijven.");
    } else if (cap === 0) {
      console.warn(
        `Dagcap bereikt (${status.gemini.gebruikt}/${inst.dagcap} verzoeken): ${wacht.length} bericht(en) wachten tot de volgende quotumdag.`
      );
    } else {
      console.log(
        `AI voor hooguit ${Math.min(wacht.length, cap * BATCH_GROOTTE)} van ${wacht.length} bericht(en): ` +
          `${cap} verzoek(en) beschikbaar, ${BATCH_GROOTTE} berichten per verzoek ` +
          `(vandaag al ${status.gemini.gebruikt}/${inst.dagcap}; prompt ${PROMPT_VERSIE_WIRE}).`
      );
      const resultaten = await schrijf(
        wacht.map((n) => n.invoer),
        apiKey,
        cap,
        { tags: tagsVoorPrompt(RUBRIEKEN) }
      );

      // Het quotum telt beantwoorde verzoeken. Een eigen schrijf-functie (bijvoorbeeld
      // in een test) die dat niet meldt, wordt per geslaagd bericht geteld.
      const verzoeken =
        typeof resultaten.verzoeken === "number"
          ? resultaten.verzoeken
          : [...resultaten.values()].filter((r) => r.melding || r.onvoldoende).length;
      status.gemini.gebruikt += verzoeken;
      run.verzoeken += verzoeken;

      const quotaHit = [...resultaten.values()].find((r) => r.status === 429);
      if (quotaHit) {
        status.gemini.wachtTot = wachtTotNaQuotum(quotaHit.fout, nu);
        console.warn(`AI-quotum bereikt. Nieuwe poging toegestaan na ${status.gemini.wachtTot}`);
      }

      const bijId = new Map(nieuwe.map((n) => [n.record.id, n]));
      verwerkt = nieuwe.map((n) => {
        const x = bijId.get(n.record.id);
        return x.invoer ? wire.verwerkMelding(x, resultaten.get(x.invoer.id)) : x.record;
      });
      const telling = {};
      for (const r of verwerkt) if (r.controle) telling[r.controle] = (telling[r.controle] || 0) + 1;
      console.log(`Controle-uitkomsten: ${JSON.stringify(telling)}`);

      kwaliteitRun = kwaliteitVan(nieuwe, verwerkt, resultaten);
    }
  }
  const tagTelling = {};
  for (const r of verwerkt) {
    const sleutel = r.tagBron || "onbekend";
    tagTelling[sleutel] = (tagTelling[sleutel] || 0) + 1;
  }
  console.log(`Tags van nieuwe berichten, naar herkomst van de keuze: ${JSON.stringify(tagTelling)}`);

  let records = wire.voegBerichtenSamen(bestaand, [...verwerkt, ...bijgewerkteControle], nu);

  logFase("ZANP 6 — Dubbel nieuws");
  let clusterResultaat = {
    clusterVan: new Map(),
    clusters: new Map(),
    beslissingen: status.clusterBeslissingen,
    stats: {},
  };
  try {
    if (!status.gemini.wachtTot || new Date(status.gemini.wachtTot) <= nu) {
      const clusterRuimte = Math.max(0, Math.min(inst.clusterCap, inst.dagcap - status.gemini.gebruikt)); // verzoeken
      const vraagAI = apiKey
        ? async (paren) => {
            const gevraagd = paren.slice(0, clusterRuimte * ZELFDE_PER_VERZOEK);
            const antwoorden = await beslisZelfde(gevraagd, apiKey, clusterRuimte);
            const verzoeken =
              typeof antwoorden.verzoeken === "number"
                ? antwoorden.verzoeken
                : [...antwoorden.values()].filter((v) => v !== null).length;
            status.gemini.gebruikt += verzoeken;
            run.verzoeken += verzoeken;
            // Alleen een echte quotummelding (429) zet de AI stil, geen enkel onduidelijk antwoord.
            if (antwoorden.quotum) {
              status.gemini.wachtTot = wachtTotNaQuotum(antwoorden.quotumTekst, nu);
              console.warn(`AI-quotum bereikt bij het clusteren. Nieuwe poging toegestaan na ${status.gemini.wachtTot}`);
            }
            return antwoorden;
          }
        : undefined;
      clusterResultaat = await bouwClusters(records, {
        nu,
        beslissingen: status.clusterBeslissingen,
        vraagAI,
        maxAI: apiKey ? clusterRuimte * ZELFDE_PER_VERZOEK : 0,
      });
      status.clusterBeslissingen = clusterResultaat.beslissingen;
    }
    records = pasClustersToe(records, clusterResultaat.clusterVan);
    console.log(`Clusters: ${JSON.stringify(clusterResultaat.stats)}`);
    samenvatting.cluster = clusterResultaat.stats;
  } catch (fout) {
    console.error(`Clusteren mislukte (de stroom blijft ongegroepeerd): ${fout.stack || fout.message}`);
  }

  logFase(`ZANP 7 — Alerts (modus ${inst.alertModus})`);
  try {
    records = bepaalAlerts(records, clusterResultaat, inst.alertModus, nu);
    const nAlerts = records.filter((r) => r.alert || r.alertKandidaat).length;
    samenvatting.alerts = nAlerts;
    for (const r of records.filter((x) => x.alert || x.alertKandidaat)) {
      const a = r.alert || r.alertKandidaat;
      console.log(`  ${a.niveau.toUpperCase()} ${a.categorie}: ${r.kop.slice(0, 70)} — ${a.reden}`);
    }
    console.log(
      `${nAlerts} alert(s)${inst.alertModus === "log" ? " (alleen gelogd, niet getoond)" : ""}.`
    );
  } catch (fout) {
    console.error(`Alerts bepalen mislukte (de stroom gaat door zonder alerts): ${fout.stack || fout.message}`);
  }

  logFase("ZANP 8 — Agenda opbouwen en opslaan");
  const agenda = wire.bouwAgenda({
    ruweBerichten: ruwe,
    bronPerId,
    bestaand: bestaandeAgenda,
    berichtRecords: records,
    nu,
  });
  let agendaItems = agenda.items;

  // Koppelen op harde sleutels (adres, ECLI, zaaknummer, OLO): een bekendmaking,
  // de hoorzitting erover en het besluit dat eruit volgt. Een fout hier mag de
  // run niet stoppen; dan blijven de koppelingen uit de bron staan.
  try {
    const gekoppeld = koppelDossiers(records, agendaItems);
    records = gekoppeld.records;
    agendaItems = gekoppeld.agendaItems;
    samenvatting.koppel = gekoppeld.stats;
    console.log(`Koppelingen op harde sleutels: ${JSON.stringify(gekoppeld.stats)}`);
  } catch (fout) {
    console.error(`Koppelen mislukte (berichten en agenda blijven ongekoppeld): ${fout.stack || fout.message}`);
  }
  records = wire.koppelAgendaAanBerichten(records, agendaItems);
  samenvatting.agenda = agenda.stats;
  console.log(`Agenda: ${JSON.stringify(agenda.stats)}`);

  if (kwaliteitRun) {
    status.kwaliteit = bewaarKwaliteit(status.kwaliteit, kalenderdagAmsterdam(nu.toISOString()), kwaliteitRun);
    samenvatting.kwaliteit = kwaliteitRun;
    console.log(`Kwaliteit van deze run: ${JSON.stringify(kwaliteitRun)}`);
  }

  const gegenereerdOp = nu.toISOString();
  await schrijfJson("agenda.json", { gegenereerdOp, regelVersie: REGEL_VERSIE, items: agendaItems });
  await schrijfJson("berichten.json", {
    gegenereerdOp,
    promptVersie: PROMPT_VERSIE_WIRE,
    alertModus: inst.alertModus,
    prioSchaal:
      "1 = urgent, 2 = belangrijk, 3 = regulier, 4 = routine. De AI geeft nooit prio 1.",
    rubrieken: RUBRIEKEN,
    berichten: records,
  });
  await schrijfJson("zanp-status.json", {
    gegenereerdOp,
    alertModus: inst.alertModus,
    bronnen: status.bronnen,
    bronnenZonderRubriek: zonderRubriek,
    gemini: { ...status.gemini, dagcap: inst.dagcap, runcap: inst.runcap, verzoekenDezeRun: run.verzoeken },
    clusterBeslissingen: status.clusterBeslissingen,
    kwaliteit: status.kwaliteit,
    laatsteRun: samenvatting,
  });
  console.log(
    `Klaar: ${records.length} berichten, ${agendaItems.length} agenda-items, ${
      records.filter((r) => r.ai).length
    } met AI-tekst, ${run.verzoeken} AI-verzoek(en).`
  );
  logDuur(startRun, "ZANP-run");
  return { records, agenda: agendaItems, status, samenvatting };
}

// Wat de AI deze run deed, in getallen: de kwaliteitslog. Zo zie je over de
// dagen heen hoe vaak de cijfercontrole een melding afkeurt of een antwoord
// ontbreekt, en kun je de prompt daarop bijsturen.
function kwaliteitVan(nieuwe, verwerkt, resultaten) {
  const uit = {
    verzoeken: typeof resultaten.verzoeken === "number" ? resultaten.verzoeken : 0,
    berichten: 0,
    ok: 0,
    analyseOk: 0,
    cijfersAfgekeurd: 0,
    onvoldoende: 0,
    fout: 0,
    overgeslagen: 0,
    tagAi: 0,
    tagTrefwoord: 0,
    tagBron: 0,
    tagGeen: 0,
  };
  const recordPerId = new Map(verwerkt.map((r) => [r.id, r]));
  for (const n of nieuwe) {
    if (!n.invoer) continue;
    const res = resultaten.get(n.invoer.id);
    const rec = recordPerId.get(n.record.id);
    if (!res) continue;
    if (res.fout) {
      if (/^overgeslagen/.test(res.fout)) uit.overgeslagen++;
      else {
        uit.berichten++;
        uit.fout++;
      }
      continue;
    }
    uit.berichten++;
    if (res.onvoldoende) uit.onvoldoende++;
    else if (rec && rec.controle === "cijfers-afgekeurd") uit.cijfersAfgekeurd++;
    else if (rec && rec.controle === "analyse-ok") uit.analyseOk++;
    else if (rec && rec.controle === "cijfers-ok") uit.ok++;
    if (rec && rec.tagBron === "ai") uit.tagAi++;
    else if (rec && rec.tagBron === "trefwoord") uit.tagTrefwoord++;
    else if (rec && rec.tagBron === "bron") uit.tagBron++;
    else uit.tagGeen++;
  }
  return uit;
}

// Telt de run op bij de dag en bewaart de laatste KWALITEIT_DAGEN dagen.
function bewaarKwaliteit(huidig, dag, run) {
  const uit = { ...(huidig || {}) };
  const vorige = uit[dag] || {};
  const som = {};
  for (const [k, v] of Object.entries(run)) som[k] = (Number(vorige[k]) || 0) + v;
  som.runs = (Number(vorige.runs) || 0) + 1;
  uit[dag] = som;
  const dagen = Object.keys(uit).sort();
  for (const d of dagen.slice(0, Math.max(0, dagen.length - KWALITEIT_DAGEN))) delete uit[d];
  return uit;
}

module.exports = {
  draai,
  bepaalAlerts,
  isAanDeBeurt,
  bronInterval,
  leesInstellingen,
  migreerBericht,
  migreerAgendaItem,
  quotumDag,
  volgendeQuotumReset,
  wachtTotNaQuotum,
  kwaliteitVan,
  bewaarKwaliteit,
};

if (require.main === module) {
  draai().catch((fout) => {
    console.error("ZANP-run mislukt:", fout.stack || fout.message);
    process.exit(1);
  });
}
