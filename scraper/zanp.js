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
// Sinds 2026-10-26:
//  - ZANP draait op gemini-flash-lite-latest (ruim quotum).
//  - Stroomonderbreker: bij een 429 slaat ZANP de AI over tot de wachttijd
//    verstreken is (opgeslagen in zanp-status.json).
//  - Teller telt alleen geslaagde aanroepen (melding of onvoldoende).

const bronnen = require("./bronnen");
const { RUBRIEKEN, isBekendeBron, profielVoor } = require("./rubrieken");
const { binnenVenster, vulBerichtenAanMetTekst, oorzaakTekst, vandaagAmsterdam } = require("./hulpmiddelen");
const gedeeld = require("./gedeeld");
const wire = require("./wire");
const { REGEL_VERSIE, beoordeelAgendaRelevantie } = require("./agenda-regels");
const { bouwClusters, pasClustersToe, clusterContext, kiesPrimair } = require("./cluster");
const { CONFIG: ALERT_CONFIG, beoordeelAlert, beperkAlerts } = require("./alert-regels");
const { schrijfMeldingen, beslisZelfdeNieuwsfeit, PROMPT_VERSIE_WIRE } = require("./gemini");

const { logFase, logDuur, schrijfJson, leesJson } = gedeeld;

const UUR_MS = 3600 * 1000;
const INTERVAL_DAG_MS = 20 * UUR_MS; // "één keer per dag", met ruimte voor vertraagde runs
const INTERVAL_SNEL_MS = 25 * 60 * 1000; // een half-uurlijkse run valt hier altijd overheen
const HERKOMST_RANG = { officieel: 0, organisatie: 1, signaal: 2, onbekend: 3 };
const ALERT_VENSTER_UREN = 48;

function getal(naam, standaard, env) {
  // Een lege variabele (bijvoorbeeld uit een workflow) betekent: standaard.
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

// ---------------------------------------------------------------------------
// Status en bronkeuze
// ---------------------------------------------------------------------------

function leegStatus() {
  return { bronnen: {}, gemini: { dag: null, gebruikt: 0, wachtTot: null }, clusterBeslissingen: {} };
}

async function leesStatus() {
  const s = await leesJson("zanp-status.json", null);
  if (!s || typeof s !== "object") return leegStatus();
  return {
    ...leegStatus(),
    ...s,
    bronnen: s.bronnen && typeof s.bronnen === "object" ? s.bronnen : {},
    gemini: s.gemini && typeof s.gemini === "object" ? s.gemini : { dag: null, gebruikt: 0, wachtTot: null },
    clusterBeslissingen: s.clusterBeslissingen && typeof s.clusterBeslissingen === "object" ? s.clusterBeslissingen : {},
  };
}

function bronInterval(bron) {
  return bron.soort === "agenda" || bron.rustig ? INTERVAL_DAG_MS : INTERVAL_SNEL_MS;
}

function isAanDeBeurt(bron, status, nu, alles) {
  if (alles) return true;
  const s = status.bronnen[bron.id];
  if (!s || !s.laatsteScrape) return true;
  return nu.getTime() - new Date(s.laatsteScrape).getTime() >= bronInterval(bron);
}

// ---------------------------------------------------------------------------
// Alerts per cluster
// ---------------------------------------------------------------------------

function uurNa(iso, uren) {
  return new Date(new Date(iso).getTime() + uren * UUR_MS).toISOString();
}

const NIVEAU_RANG = { rood: 0, oranje: 1 };
const CATEGORIE_RANG = { veiligheid: 0, bestuur: 1, economie: 2 };

/**
 * Beoordeelt alle recente berichten en zet per cluster hooguit één alert, op
 * het primaire bericht. Geeft nieuwe records terug. In modus "log" komt het
 * resultaat in record.alertKandidaat (de frontend toont dat niet), in modus
 * "aan" in record.alert.
 */
function bepaalAlerts(records, clusterResultaat, modus, nu) {
  const context = clusterContext(records, clusterResultaat.clusterVan, clusterResultaat.clusters);
  const grens = nu.getTime() - ALERT_VENSTER_UREN * UUR_MS;

  // Nieuwste versie per groep, recent genoeg.
  const nieuwste = new Map();
  for (const r of records) {
    const v = nieuwste.get(r.groepId);
    if (!v || (r.versie || 1) > (v.versie || 1)) nieuwste.set(r.groepId, r);
  }
  const recent = [...nieuwste.values()].filter((r) => new Date(r.tijd).getTime() >= grens);

  // Per cluster (of los bericht) de beste kandidaat.
  const perCluster = new Map();
  for (const r of recent) {
    const sleutel = r.clusterId || r.groepId;
    if (!perCluster.has(sleutel)) perCluster.set(sleutel, []);
    perCluster.get(sleutel).push(r);
  }

  const toewijzing = new Map(); // record.id -> alert
  const voorBeperking = [];
  for (const [sleutel, leden] of perCluster) {
    const ctx = context.get(sleutel) || { aantalBronnen: 1, heeftOfficieleBron: leden[0].herkomst === "officieel" };
    let beste = null;
    for (const lid of leden) {
      const a = beoordeelAlert(lid, ctx, { nu });
      if (!a) continue;
      if (
        !beste ||
        NIVEAU_RANG[a.niveau] < NIVEAU_RANG[beste.alert.niveau] ||
        (NIVEAU_RANG[a.niveau] === NIVEAU_RANG[beste.alert.niveau] && CATEGORIE_RANG[a.categorie] < CATEGORIE_RANG[beste.alert.categorie])
      ) {
        beste = { lid, alert: a };
      }
    }
    if (!beste) continue;

    // Een alert die al bestond houdt zijn begintijdstip, zodat hij niet
    // elke run opnieuw "nieuw" is en op tijd vervalt.
    const eerder = leden.map((l) => l.alert || l.alertKandidaat).find((e) => e && e.categorie === beste.alert.categorie);
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

// ---------------------------------------------------------------------------
// Oude data (fase 1) omzetten
// ---------------------------------------------------------------------------

// De eerste fase schreef "soort" in plaats van "herkomst" en kende geen
// gecontroleerdOp. Zonder omzetting zouden alerts en de keuze van de beste
// bron in een cluster geen herkomst zien. De huidige instelling in
// rubrieken.json wint van de oude waarde.
function migreerBericht(r) {
  if (r.herkomst && !("soort" in r) && r.gecontroleerdOp) return r;
  const { soort, ...rest } = r;
  const profiel = profielVoor(r.bronId);
  return {
    ...rest,
    herkomst: r.herkomst || (isBekendeBron(r.bronId) ? profiel.herkomst : soort) || "onbekend",
    gecontroleerdOp: r.gecontroleerdOp || r.eerstGezienOp,
  };
}

// Oude agenda-items hebben geen beoordeling. Bij "alles" zijn ze gewoon
// zichtbaar. Bij een bron met het filter eerste-keer-of-jubileum zetten we ze
// op "in afwachting" (verborgen): komen ze opnieuw voorbij in de bron, dan
// worden ze beoordeeld; anders blijven ze verborgen tot ze verlopen. Zo lekken
// oude items niet ongefilterd de agenda in.
function migreerAgendaItem(i) {
  if (i.relevantie !== undefined) return i.afkomst ? i : { ...i, afkomst: "bron" };
  const filter = profielVoor(i.bronId).agendaFilter;
  if (filter === "eerste-of-jubileum") {
    return { ...i, afkomst: i.afkomst || "bron", zichtbaar: false, inAfwachting: true };
  }
  return {
    ...i,
    afkomst: i.afkomst || "bron",
    relevantie: beoordeelAgendaRelevantie(i.kop, "", "alles"),
    zichtbaar: true,
    inAfwachting: false,
  };
}

// ---------------------------------------------------------------------------
// De run
// ---------------------------------------------------------------------------

/**
 * @param {object} deps  voor tests: { nu, apiKey, env, scrape, haalTekst, schrijf, beslisZelfde }
 */
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

  // ---- 1. status en bronkeuze ---------------------------------------------
  logFase("ZANP 1 — Bronnen kiezen");
  const status = await leesStatus();
  const vandaag = vandaagAmsterdam();
  if (status.gemini.dag !== vandaag) status.gemini = { dag: vandaag, gebruikt: 0, wachtTot: null };

  const regionaal = bronnen.filter((b) => b.categorie !== "landelijk");
  const teScrapen = regionaal.filter((b) => isAanDeBeurt(b, status, nu, inst.alles));
  console.log(
    `${teScrapen.length} van ${regionaal.length} regionale bronnen aan de beurt`
      + `${bronnen.length > regionaal.length ? ` (${bronnen.length - regionaal.length} landelijke bron(nen) doen niet mee)` : ""}.`
  );
  const zonderRubriek = bronnen.filter((b) => !isBekendeBron(b.id)).map((b) => b.id);
  for (const id of zonderRubriek) {
    console.warn(`[${id}] Staat niet in rubrieken.json: rubriek Overig, geen AI-tekst, agendafilter uit. Voeg de bron daar toe.`);
  }

  // ---- 2. scrapen -----------------------------------------------------------
  logFase("ZANP 2 — Scrapen");
  const startScrapen = Date.now();
  const ruwe = teScrapen.length ? await scrape(teScrapen) : [];
  logDuur(startScrapen, `Scrapen van ${teScrapen.length} bronnen`);
  const bronPerId = Object.fromEntries(bronnen.map((b) => [b.id, gedeeld.effectieveBron(b)]));

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
      gedeeld.GEEN_TEKSTOPHAAL_TYPES.has(bronPerId[b.bronId] && bronPerId[b.bronId].type) || gedeeld.GEEN_TEKSTOPHAAL_BRONNEN.has(b.bronId),
    detailSelectorVoor: (b) => {
      const bron = bronPerId[b.bronId];
      return bron && bron.detailSelector ? bron.detailSelector : null;
    },
  };

  // ---- 3. agenda: detailtekst voor het filter -------------------------------
  logFase("ZANP 3 — Agenda: detailtekst voor het filter");
  const agendaBestand = await leesJson("agenda.json", { items: [] });
  const bestaandeAgenda = (Array.isArray(agendaBestand.items) ? agendaBestand.items : []).map(migreerAgendaItem);
  const teVerrijkenAgenda = wire.agendaTeVerrijken({ ruweBerichten: ruwe, bronPerId, bestaand: bestaandeAgenda, max: inst.agendaDetailMax, nu });
  console.log(`${teVerrijkenAgenda.length} agenda-item(s) krijgen een detailpagina-controle (max ${inst.agendaDetailMax}).`);
  if (teVerrijkenAgenda.length) {
    try {
      await haalTekst(teVerrijkenAgenda, opties);
    } catch (fout) {
      console.error(`Detailtekst voor de agenda ophalen mislukte (de items worden beoordeeld op de lijsttekst): ${fout.message}${oorzaakTekst(fout)}`);
    }
    for (const b of teVerrijkenAgenda) b._verrijkt = true;
  }

  // ---- 4. nieuws: wat heeft tekst nodig? ------------------------------------
  logFase("ZANP 4 — Nieuws: nieuwe en gewijzigde berichten");
  const berichtenBestand = await leesJson("berichten.json", { berichten: [] });
  const bestaand = (Array.isArray(berichtenBestand.berichten) ? berichtenBestand.berichten : []).map(migreerBericht);
  const laatstePerUrl = new Map();
  for (const r of bestaand) {
    const v = laatstePerUrl.get(r.url);
    if (!v || (r.versie || 1) > (v.versie || 1)) laatstePerUrl.set(r.url, r);
  }

  const binnen = (b) => binnenVenster(b.gepubliceerdOp, bronPerId[b.bronId], b.eindDatum);
  const nieuwsRuw = gedeeld.verwijderDubbelen(ruwe).filter((b) => !gedeeld.isAgendaItem(b) && binnen(b) && gedeeld.nietInToekomst(b.gepubliceerdOp));

  const teTekst = [];
  for (const b of nieuwsRuw) {
    const vorige = laatstePerUrl.get(b.url);
    if (!vorige) {
      teTekst.push(b);
      continue;
    }
    const jong = nu.getTime() - new Date(vorige.eerstGezienOp).getTime() < 24 * UUR_MS;
    const lang = nu.getTime() - new Date(vorige.gecontroleerdOp || vorige.eerstGezienOp).getTime() >= inst.versieControleUren * UUR_MS;
    const mislukt = !vorige.seed && (vorige.controle === null || vorige.controle === "ai-fout") && !vorige.ai && !vorige.analyse;
    if ((jong && lang) || mislukt) teTekst.push(b);
  }
  const teTekstGekapt = teTekst.slice(0, inst.tekstMax);
  console.log(`${nieuwsRuw.length} berichten in het venster; tekst nodig voor ${teTekstGekapt.length}${teTekst.length > teTekstGekapt.length ? ` (van ${teTekst.length}, de rest volgt)` : ""}.`);
  if (teTekstGekapt.length) {
    try {
      await haalTekst(teTekstGekapt, opties);
    } catch (fout) {
      console.error(`Tekst ophalen mislukte onverwacht (de berichten gaan door met de lijstgegevens): ${fout.message}${oorzaakTekst(fout)}`);
    }
  }

  const feedItems = await leesJson("feed.json", []);
  const { nieuwe, bijgewerkteControle, stats: planStats } = wire.planBerichten({
    vensterBerichten: teTekstGekapt,
    feedItems: Array.isArray(feedItems) ? feedItems : [],
    bestaand,
    nu,
  });
  console.log(
    `Berichten: ${planStats.nieuw} nieuw, ${planStats.update} nieuwe versie(s), ${planStats.opnieuw} opnieuw voor AI, `
      + `${planStats.ongewijzigd} ongewijzigd${bestaand.length === 0 ? `, ${planStats.seed} kale signalen uit de feed (eerste run)` : ""}.`
  );
  samenvatting.berichten = planStats;

  // ---- 5. AI ----------------------------------------------------------------
  logFase("ZANP 5 — Meldingen en analyses");
  let verwerkt = nieuwe.map((n) => n.record);
  
  if (status.gemini.wachtTot && new Date(status.gemini.wachtTot) > nu) {
    console.warn(`AI overgeslagen: quotum bereikt, wacht tot ${status.gemini.wachtTot}.`);
  } else {
    const wacht = nieuwe
      .filter((n) => n.invoer)
      .sort((a, b) => (HERKOMST_RANG[a.record.herkomst] ?? 3) - (HERKOMST_RANG[b.record.herkomst] ?? 3));
    const dagRuimte = Math.max(0, inst.dagcap - status.gemini.gebruikt);
    const cap = Math.min(inst.runcap, dagRuimte);
    
    if (!apiKey) {
      if (wacht.length) console.log(`Geen API-sleutel: ${wacht.length} bericht(en) blijven kop + link.`);
    } else if (wacht.length === 0) {
      console.log("Niets te schrijven.");
    } else if (cap === 0) {
      console.warn(`Dagcap bereikt (${status.gemini.gebruikt}/${inst.dagcap}): ${wacht.length} bericht(en) wachten tot morgen.`);
    } else {
      console.log(`AI voor ${Math.min(wacht.length, cap)} van ${wacht.length} bericht(en) (cap ${cap}; vandaag al ${status.gemini.gebruikt}/${inst.dagcap}; prompt ${PROMPT_VERSIE_WIRE}).`);
      const resultaten = await schrijf(wacht.map((n) => n.invoer), apiKey, cap);
      
      let quotaHit = false;
      let retryAfterText = "";
      
      for (const r of resultaten.values()) {
        if (r.melding || r.onvoldoende) status.gemini.gebruikt++;
        if (r.status === 429) {
          quotaHit = true;
          retryAfterText = r.fout;
        }
      }
      
      if (quotaHit) {
        let wachtMinuten = 12 * 60; // fallback 12 uur
        const match = retryAfterText.match(/retry in (.*?)\./);
        if (match) {
          const timeStr = match[1];
          let mins = 0;
          const h = timeStr.match(/(\d+)h/);
          const m = timeStr.match(/(\d+)m/);
          if (h) mins += parseInt(h[1]) * 60;
          if (m) mins += parseInt(m[1]);
          if (mins > 0) wachtMinuten = mins;
        }
        status.gemini.wachtTot = new Date(nu.getTime() + wachtMinuten * 60000).toISOString();
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
    }
  }

  let records = wire.voegBerichtenSamen(bestaand, [...verwerkt, ...bijgewerkteControle], nu);

  // ---- 6. dubbel nieuws -----------------------------------------------------
  logFase("ZANP 6 — Dubbel nieuws");
  let clusterResultaat = { clusterVan: new Map(), clusters: new Map(), beslissingen: status.clusterBeslissingen, stats: {} };
  try {
    if (!status.gemini.wachtTot || new Date(status.gemini.wachtTot) <= nu) {
      const clusterRuimte = Math.max(0, Math.min(inst.clusterCap, inst.dagcap - status.gemini.gebruikt));
      const vraagAI = apiKey
        ? async (paren) => {
            const gevraagd = paren.slice(0, clusterRuimte);
            const antwoorden = await beslisZelfde(gevraagd, apiKey, clusterRuimte);
            let successen = 0;
            let foutOpgetreden = false;
            for (const val of antwoorden.values()) {
              if (val !== null) successen++;
              else foutOpgetreden = true;
            }
            status.gemini.gebruikt += successen;
            if (foutOpgetreden) {
              // Fallback voor het geval we de exacte 429 niet kunnen achterhalen
              status.gemini.wachtTot = new Date(nu.getTime() + 12 * 60 * 60000).toISOString();
            }
            return antwoorden;
          }
        : undefined;
      clusterResultaat = await bouwClusters(records, {
        nu,
        beslissingen: status.clusterBeslissingen,
        vraagAI,
        maxAI: apiKey ? clusterRuimte : 0,
      });
      status.clusterBeslissingen = clusterResultaat.beslissingen;
    }
    records = pasClustersToe(records, clusterResultaat.clusterVan);
    console.log(`Clusters: ${JSON.stringify(clusterResultaat.stats)}`);
    samenvatting.cluster = clusterResultaat.stats;
  } catch (fout) {
    console.error(`Clusteren mislukte (de stroom blijft ongegroepeerd): ${fout.stack || fout.message}`);
  }

  // ---- 7. alerts ------------------------------------------------------------
  logFase(`ZANP 7 — Alerts (modus ${inst.alertModus})`);
  try {
    records = bepaalAlerts(records, clusterResultaat, inst.alertModus, nu);
    const nAlerts = records.filter((r) => r.alert || r.alertKandidaat).length;
    samenvatting.alerts = nAlerts;
    for (const r of records.filter((x) => x.alert || x.alertKandidaat)) {
      const a = r.alert || r.alertKandidaat;
      console.log(`  ${a.niveau.toUpperCase()} ${a.categorie}: ${r.kop.slice(0, 70)} — ${a.reden}`);
    }
    console.log(`${nAlerts} alert(s)${inst.alertModus === "log" ? " (alleen gelogd, niet getoond)" : ""}.`);
  } catch (fout) {
    console.error(`Alerts bepalen mislukte (de stroom gaat door zonder alerts): ${fout.stack || fout.message}`);
  }

  // ---- 8. agenda en wegschrijven -------------------------------------------
  logFase("ZANP 8 — Agenda opbouwen en opslaan");
  const agenda = wire.bouwAgenda({ ruweBerichten: ruwe, bronPerId, bestaand: bestaandeAgenda, berichtRecords: records, nu });
  records = wire.koppelAgendaAanBerichten(records, agenda.items);
  samenvatting.agenda = agenda.stats;
  console.log(`Agenda: ${JSON.stringify(agenda.stats)}`);

  const gegenereerdOp = nu.toISOString();
  await schrijfJson("agenda.json", { gegenereerdOp, regelVersie: REGEL_VERSIE, items: agenda.items });
  await schrijfJson("berichten.json", {
    gegenereerdOp,
    promptVersie: PROMPT_VERSIE_WIRE,
    alertModus: inst.alertModus,
    prioSchaal: "1 = urgent, 2 = belangrijk, 3 = regulier, 4 = routine. De AI geeft nooit prio 1.",
    rubrieken: RUBRIEKEN,
    berichten: records,
  });
  await schrijfJson("zanp-status.json", {
    gegenereerdOp,
    alertModus: inst.alertModus,
    bronnen: status.bronnen,
    bronnenZonderRubriek: zonderRubriek,
    gemini: { ...status.gemini, dagcap: inst.dagcap },
    clusterBeslissingen: status.clusterBeslissingen,
    laatsteRun: samenvatting,
  });
  console.log(`Klaar: ${records.length} berichten, ${agenda.items.length} agenda-items, ${records.filter((r) => r.ai).length} met AI-tekst.`);
  logDuur(startRun, "ZANP-run");
  return { records, agenda: agenda.items, status, samenvatting };
}

module.exports = { draai, bepaalAlerts, isAanDeBeurt, leesInstellingen, migreerBericht, migreerAgendaItem };

if (require.main === module) {
  draai().catch((fout) => {
    console.error("ZANP-run mislukt:", fout.stack || fout.message);
    process.exit(1);
  });
}
