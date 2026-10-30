// wire.js
//
// ZANP (2026-10-23, fase 2 op 2026-10-24): de persdienst-laag.
//
// Dit bestand maakt de inhoud van twee databestanden die de frontend leest:
//   data/berichten.json  de stroom: kop, korte tekst, rubriek, prio, versie,
//                        checklist, agendapunten, termijnen
//   data/agenda.json     de weekagenda: scrapete items (met het filter eerste
//                        keer of jubileum) plus agendapunten en termijnen die
//                        uit berichten komen
//
// Het bevat GEEN netwerk- of AI-aanroepen. Gemini zit in gemini.js
// (schrijfMeldingen); dit bestand bereidt voor en verwerkt het resultaat.
// Zonder API-sleutel werkt alles dus gewoon: dan staat in de stroom de
// originele kop zonder tekst.
//
// DRIE BEWUSTE KEUZES
//
// 1. Rubriek en standaardprio komen uit de BRON (rubrieken.js), niet uit de
//    AI. Dat is betrouwbaarder en uitlegbaar. De AI mag de prio alleen met
//    één stap bijstellen (begrensPrio) en geeft nooit prio 1: een flits is
//    een beslissing voor een mens.
//
// 2. De AI mag alleen herschrijven wat in de brontekst staat. Daar hoort een
//    harde controle bij: elk getal in de uitvoer moet ook in de bron staan
//    (cijfersKloppen). Faalt dat, dan blijft de originele kop staan en
//    krijgt het bericht controle: "cijfers-afgekeurd". Namen en plaatsen
//    worden NIET gecontroleerd; daarom staat in de frontend altijd dat de
//    tekst automatisch is samengevat.
//
// 3. Versies: een bericht is hetzelfde bericht als de url gelijk is. Is de
//    kop veranderd, of de brontekst merkbaar langer of korter geworden,
//    dan komt er een nieuw record bij met versie + 1. Het oude blijft staan
//    (zoals bij het ANP). Ruis zoals een reactieteller verandert de lengte
//    nauwelijks en telt dus niet. BEPERKING: dit werkt alleen voor berichten
//    die binnen het nieuwsvenster van de run vallen (circa twee dagen).

const crypto = require("crypto");
const { TZ, kalenderdagAmsterdam, vandaagAmsterdam, dagVerschil } = require("./hulpmiddelen");
const { profielVoor, RUBRIEKEN } = require("./rubrieken");
const {
  REGEL_VERSIE,
  beoordeelAgendaRelevantie,
  datumUitTekst,
  klokUitTekst,
  termijnenUitTekst,
  titelGelijkenis,
} = require("./agenda-regels");
const { isRegio } = require("./alert-regels");
const { ONBEKEND, bepaalTag } = require("./tags");
const { checklistUitPatronen, agendapuntenUitPatronen } = require("./patronen");

// De tags (kolommen) uit rubrieken.json, zonder "Overig". Het veld "rubriek"
// van een bericht bevat de tag.
const TAG_CODES = RUBRIEKEN.map((r) => r.code).filter((c) => c !== ONBEKEND);
const TAG_NAMEN = Object.fromEntries(RUBRIEKEN.map((r) => [r.code, r.naam]));

const DAG_MS = 24 * 60 * 60 * 1000;

const AGENDA_TERUG_DAGEN = 7;
const AGENDA_VOORUIT_DAGEN = 21;
const AGENDA_VERDWENEN_NA_DAGEN = 3;

const BERICHTEN_MAX_DAGEN = 30;
const BERICHTEN_MAX_AANTAL = 1500;
const SEED_MAX_DAGEN = 7;

const MIN_TEKST_VOOR_AI = 80;
const MAX_AGENDAPUNTEN_PER_BERICHT = 3;
const TITEL_DUBBEL_DREMPEL = 0.5;
const AFGEKAPT_VANAF_TEKENS = 5900; // ARTIKEL_MAX_TEKENS is 6000
const MAX_KOP_TEKENS = 160;

// ---------------------------------------------------------------------------
// Kleine hulpfuncties
// ---------------------------------------------------------------------------

function korteId(tekst) {
  return crypto.createHash("sha1").update(String(tekst)).digest("hex").slice(0, 10);
}

function opschonen(tekst) {
  return String(tekst ?? "").replace(/\s+/g, " ").trim();
}

function aantalWoorden(tekst) {
  const t = opschonen(tekst);
  return t ? t.split(" ").length : 0;
}

function schoneKop(titel) {
  const t = opschonen(titel);
  if (!t) return "(geen titel)";
  return t.length > MAX_KOP_TEKENS ? `${t.slice(0, MAX_KOP_TEKENS - 1).trimEnd()}…` : t;
}

function volgendeDag(dag, aantal) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + aantal);
  return d.toISOString().slice(0, 10);
}

// "HH:MM" op de Amsterdamse klok, of null bij een ongeldige datum.
function amsterdamTijd(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("nl-NL", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

// Veel bronnen leveren alleen een datum; die staat dan op 00:00 Amsterdamse tijd.
function heeftEchteTijd(iso) {
  const t = amsterdamTijd(iso);
  return t !== null && t !== "00:00";
}

// Amsterdamse kalenderdag + klok → ISO (UTC). Rekent de zomer- en wintertijd uit.
function amsterdamNaarIso(dag, uur, minuut) {
  const [j, m, d] = dag.split("-").map(Number);
  const gok = Date.UTC(j, m - 1, d, uur, minuut);
  const getoond = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(gok));
  const [datumDeel, tijdDeel] = getoond.split(" ");
  const [uj, um, ud] = datumDeel.split("-").map(Number);
  const [uu, umin] = tijdDeel.split(":").map(Number);
  const verschil = Date.UTC(uj, um - 1, ud, uu, umin) - gok;
  return new Date(gok - verschil).toISOString();
}

// ---------------------------------------------------------------------------
// Tijd en status uit tekst (agenda)
// ---------------------------------------------------------------------------

const T = "(\\d{1,2})[:.](\\d{2})(?!\\d)";
const BEREIK_TIJD = new RegExp(`(?<![\\d:.])${T}\\s*(?:uur)?\\s*(?:-|–|—|tot)\\s*${T}`, "i");
const AANVANG_TIJD = new RegExp(`\\b(?:aanvang|om|vanaf|start(?:t)?(?:\\s+om)?|inloop)\\s*(?:om\\s*)?${T}`, "i");
const UUR_TIJD = new RegExp(`(?<![\\d:.])${T}\\s*uur`, "i");

function geldigeKlok(u, m) {
  return u >= 0 && u <= 23 && m >= 0 && m <= 59;
}

// Zoekt een begintijd (en eventueel eindtijd) in een stukje tekst.
// Geeft { start: [uur, min], eind: [uur, min] | null } of null.
function tijdUitTekst(tekst) {
  const t = opschonen(tekst);
  if (!t) return null;

  let m = t.match(BEREIK_TIJD);
  if (m && geldigeKlok(+m[1], +m[2]) && geldigeKlok(+m[3], +m[4])) {
    const start = [+m[1], +m[2]];
    const eind = [+m[3], +m[4]];
    const eindNaStart = eind[0] * 60 + eind[1] > start[0] * 60 + start[1];
    return { start, eind: eindNaStart ? eind : null };
  }
  m = t.match(AANVANG_TIJD);
  if (m && geldigeKlok(+m[1], +m[2])) return { start: [+m[1], +m[2]], eind: null };
  m = t.match(UUR_TIJD);
  if (m && geldigeKlok(+m[1], +m[2])) return { start: [+m[1], +m[2]], eind: null };
  return null;
}

const STATUS_PATRONEN = [
  ["VERVALLEN", /\b(vervalt|vervallen|afgelast|geannuleerd|gaat niet door)\b/i],
  ["VERPLAATST", /\bverplaatst\b/i],
  ["UITGESTELD", /\buitgesteld\b/i],
];

function statusUitTitel(titel) {
  const t = opschonen(titel);
  for (const [status, patroon] of STATUS_PATRONEN) {
    if (patroon.test(t)) return status;
  }
  return null;
}

// Hoorzittingen hebben titels als
// "2026-10-23 Vrijdag 23 oktober 2026 10:15 uur - Last onder dwangsom … - Stadhuis, Stadhuisplein 100, 1506 MZ Zaandam".
// De datum en tijd staan al in de agenda; het adres wordt de plaats.
const AGENDA_KOP_VOORVOEGSEL = /^\s*\d{4}-\d{2}-\d{2}\s+\p{L}+\s+\d{1,2}\s+\p{L}+\s+\d{4}\s+(?:om\s+)?\d{1,2}[:.]\d{2}\s*uur\s*[-–—]\s*/iu;
const POSTCODE = /\b\d{4}\s?[A-Z]{2}\b/;

function splitsAgendaTitel(titel) {
  let kop = opschonen(titel).replace(AGENDA_KOP_VOORVOEGSEL, "");
  let plaats = null;
  const idx = kop.lastIndexOf(" - ");
  if (idx > 0) {
    const staart = kop.slice(idx + 3).trim();
    if (POSTCODE.test(staart)) {
      plaats = staart;
      kop = kop.slice(0, idx).trim();
    }
  }
  return { kop: schoneKop(kop), plaats };
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

function maakAgendaItem(b, nu) {
  const profiel = profielVoor(b.bronId);
  const startDag = kalenderdagAmsterdam(b.gepubliceerdOp);
  if (!startDag) return null;

  const { kop, plaats } = splitsAgendaTitel(b.titel);
  let start;
  let eind = null;
  let heeftTijd = false;
  let tijdBron = "geen";

  if (heeftEchteTijd(b.gepubliceerdOp)) {
    start = new Date(b.gepubliceerdOp).toISOString();
    heeftTijd = true;
    tijdBron = "veld";
  } else {
    const gevonden = tijdUitTekst(`${b.titel || ""} ${b.samenvatting || ""}`);
    if (gevonden) {
      start = amsterdamNaarIso(startDag, gevonden.start[0], gevonden.start[1]);
      if (gevonden.eind) eind = amsterdamNaarIso(startDag, gevonden.eind[0], gevonden.eind[1]);
      heeftTijd = true;
      tijdBron = "tekst"; // uit de tekst gehaald: de frontend toont "±"
    } else {
      start = amsterdamNaarIso(startDag, 0, 0);
    }
  }

  if (b.eindDatum) {
    const e = new Date(b.eindDatum);
    if (!isNaN(e.getTime()) && e.getTime() > new Date(start).getTime()) eind = e.toISOString();
  }

  // Een eindtijd van precies 00:00 op een latere dag betekent: einde van de vorige dag.
  let eindDag = eind ? kalenderdagAmsterdam(eind) : startDag;
  if (eind && eindDag > startDag && amsterdamTijd(eind) === "00:00") eindDag = volgendeDag(eindDag, -1);
  if (eindDag < startDag) eindDag = startDag;

  return {
    id: korteId(`${b.url}|${startDag}`),
    url: b.url,
    kop,
    plaats,
    status: statusUitTitel(b.titel),
    rubriek: profiel.rubriek,
    herkomst: profiel.herkomst,
    afkomst: "bron",
    bronId: b.bronId,
    bronNaam: b.bronNaam,
    start,
    eind,
    startDag,
    eindDag,
    doorlopend: eindDag > startDag,
    heeftTijd,
    tijdBron,
    laatstGezienOp: nu.toISOString(),
  };
}

function agendaItemsVanBronnen(ruweBerichten, bronPerId) {
  return ruweBerichten.filter((b) => {
    const bron = bronPerId[b.bronId];
    return bron && bron.soort === "agenda" && b.url && b.gepubliceerdOp;
  });
}

/**
 * Welke gescrapete agenda-items hebben nog een beoordeling nodig? Dat zijn
 * items van bronnen met agendaFilter "eerste-of-jubileum" waarvan de
 * opgeslagen beoordeling ontbreekt of van een oudere REGEL_VERSIE is.
 * Voor die items haalt zanp.js eenmalig de detailtekst op, want een
 * lijstregel van 250 tekens is te weinig om "eerste editie" te zien.
 * Dichtstbijzijnde datum eerst, hooguit "max" stuks per run.
 */
function agendaTeVerrijken({ ruweBerichten, bronPerId, bestaand = [], max = 40, nu = new Date() }) {
  const vorige = new Map(bestaand.map((i) => [i.id, i]));
  const vandaag = vandaagAmsterdam();
  const eersteDag = volgendeDag(vandaag, -AGENDA_TERUG_DAGEN);
  const laatsteDag = volgendeDag(vandaag, AGENDA_VOORUIT_DAGEN);
  const kandidaten = [];
  const gezien = new Set();
  for (const b of agendaItemsVanBronnen(ruweBerichten, bronPerId)) {
    if (profielVoor(b.bronId).agendaFilter !== "eerste-of-jubileum") continue;
    const item = maakAgendaItem(b, nu);
    if (!item || gezien.has(item.id)) continue; // dezelfde url op dezelfde dag staat soms dubbel in een lijst
    gezien.add(item.id);
    // Alleen items die straks ook in de agenda komen; anders vult een oud
    // item een plek die een komend evenement nodig heeft.
    if (item.eindDag < eersteDag || item.startDag > laatsteDag) continue;
    const oud = vorige.get(item.id);
    const geldig = oud && oud.relevantie && oud.relevantie.regelVersie === REGEL_VERSIE && !oud.inAfwachting;
    if (!geldig) kandidaten.push({ b, item });
  }
  // Eerst wat vandaag en straks komt (dichtstbijzijnde datum eerst), daarna
  // wat al geweest is (meest recente eerst).
  kandidaten.sort((x, y) => {
    const xKomt = x.item.eindDag >= vandaag;
    const yKomt = y.item.eindDag >= vandaag;
    if (xKomt !== yKomt) return xKomt ? -1 : 1;
    if (xKomt) return x.item.startDag < y.item.startDag ? -1 : x.item.startDag > y.item.startDag ? 1 : 0;
    return x.item.startDag < y.item.startDag ? 1 : x.item.startDag > y.item.startDag ? -1 : 0;
  });
  return kandidaten.slice(0, max).map((k) => k.b);
}

// Agendapunten en termijnen die uit berichten komen. Deze worden elke run
// opnieuw afgeleid uit de berichten zelf (nooit apart bewaard), zodat ze
// altijd kloppen met de laatste versie van het bericht.
function agendaItemsUitBerichten(records, nu) {
  const perGroep = new Map();
  for (const r of [...records].sort((a, b) => (a.versie || 1) - (b.versie || 1))) perGroep.set(r.groepId, r);
  const items = [];
  for (const r of perGroep.values()) {
    const basis = {
      url: r.url,
      rubriek: r.rubriek,
      herkomst: r.herkomst,
      bronId: r.bronId,
      bronNaam: r.bronNaam,
      berichtId: r.groepId,
      status: null,
      plaats: null,
      eind: null,
      doorlopend: false,
      relevantie: { zichtbaar: true, regel: "uit-bericht", woorden: null, regelVersie: REGEL_VERSIE },
      zichtbaar: true,
      inAfwachting: false,
      laatstGezienOp: nu.toISOString(),
    };
    (r.agendapunten || []).slice(0, MAX_AGENDAPUNTEN_PER_BERICHT).forEach((ap, i) => {
      items.push({
        ...basis,
        id: korteId(`${r.groepId}|ap${i}`),
        kop: ap.titel,
        plaats: ap.plaats || null,
        start: ap.start || amsterdamNaarIso(ap.dag, 0, 0),
        eind: ap.eind || null,
        startDag: ap.dag,
        eindDag: ap.dag,
        heeftTijd: Boolean(ap.start),
        tijdBron: ap.start ? "bericht" : "geen",
        afkomst: "bericht",
        zekerheid: ap.zekerheid || "afgeleid",
      });
    });
    (r.termijnen || []).forEach((t) => {
      items.push({
        ...basis,
        id: korteId(`${r.groepId}|termijn|${t.soort}|${t.dag}`),
        kop: `Laatste dag ${t.soort}: ${r.kop}`.slice(0, MAX_KOP_TEKENS),
        start: amsterdamNaarIso(t.dag, 0, 0),
        startDag: t.dag,
        eindDag: t.dag,
        heeftTijd: false,
        tijdBron: "geen",
        afkomst: "termijn",
        zekerheid: "letterlijk",
      });
    });
  }
  return items;
}

/**
 * Voegt dubbelen samen: een agendapunt uit een bericht dat al als gescraped
 * item bestaat (zelfde dag, gelijkende titel) wordt niet apart getoond; het
 * gescrapete item krijgt een link naar het bericht.
 */
function ontdubbelAgenda(items) {
  const gescraped = items.filter((i) => i.afkomst === "bron");
  const uit = [];
  for (const item of items) {
    if (item.afkomst !== "bericht") {
      uit.push(item);
      continue;
    }
    const dubbel = gescraped.find(
      (g) => g.startDag <= item.startDag && item.startDag <= g.eindDag && titelGelijkenis(g.kop, item.kop) >= TITEL_DUBBEL_DREMPEL
    );
    if (dubbel) {
      if (!dubbel.berichtId) dubbel.berichtId = item.berichtId;
      continue;
    }
    // Hetzelfde evenement uit twee berichten (twee bronnen melden dezelfde
    // inloopavond): één keer tonen, het eerste bericht wint.
    const eerder = uit.find(
      (u) => u.afkomst === "bericht" && u.startDag === item.startDag && titelGelijkenis(u.kop, item.kop) >= TITEL_DUBBEL_DREMPEL
    );
    if (!eerder) uit.push(item);
  }
  return uit;
}

/**
 * Bouwt de agenda:
 *  1. alle gescrapete agenda-items (ook de komende weken), met het filter
 *     "eerste keer of jubileum" voor evenementenbronnen. De beoordeling
 *     wordt EENMAAL gedaan en bewaard; items zonder beoordeling staan op
 *     "inAfwachting" (verborgen) tot hun detailtekst is opgehaald. Items die
 *     afvallen blijven bewaard met zichtbaar: false;
 *  2. plus agendapunten en termijnen uit berichten;
 *  3. samengevoegd met de vorige agenda.json, met opruiming:
 *     - verlopen items (meer dan AGENDA_TERUG_DAGEN geleden) gaan weg;
 *     - gescrapete toekomstige items die hun bron al
 *       AGENDA_VERDWENEN_NA_DAGEN dagen niet meer toont, gaan weg. Alleen
 *       als die bron deze run wel iets opleverde, zodat een kapotte scraper
 *       of een bron die deze run niet draaide een agenda nooit leegmaakt.
 */
function bouwAgenda({ ruweBerichten, bronPerId, bestaand = [], berichtRecords = [], nu = new Date() }) {
  const vandaag = vandaagAmsterdam();
  const eersteDag = volgendeDag(vandaag, -AGENDA_TERUG_DAGEN);
  const laatsteDag = volgendeDag(vandaag, AGENDA_VOORUIT_DAGEN);
  const vorige = new Map(bestaand.map((i) => [i.id, i]));

  const nieuw = new Map();
  const bronnenMetItems = new Set();
  for (const b of agendaItemsVanBronnen(ruweBerichten, bronPerId)) {
    bronnenMetItems.add(b.bronId);
    const item = maakAgendaItem(b, nu);
    if (!item) continue;
    if (item.eindDag < eersteDag || item.startDag > laatsteDag) continue;

    const filter = profielVoor(b.bronId).agendaFilter;
    const oud = vorige.get(item.id);
    let relevantie;
    if (filter !== "eerste-of-jubileum") {
      relevantie = beoordeelAgendaRelevantie(item.kop, "", "alles");
    } else if (oud && oud.relevantie && oud.relevantie.regelVersie === REGEL_VERSIE && !oud.inAfwachting) {
      relevantie = oud.relevantie; // eenmalig: de eerste beoordeling blijft staan
    } else if (b._verrijkt) {
      relevantie = beoordeelAgendaRelevantie(b.titel, b.samenvatting, filter);
    } else {
      relevantie = null;
    }
    item.relevantie = relevantie;
    item.zichtbaar = relevantie ? relevantie.zichtbaar : false;
    item.inAfwachting = !relevantie;
    // Staat dezelfde url op dezelfde dag twee keer in een lijst, dan mag een
    // dubbel zonder beoordeling nooit de beoordeelde versie overschrijven.
    const eerder = nieuw.get(item.id);
    if (eerder && !(eerder.inAfwachting && relevantie)) continue;
    nieuw.set(item.id, item);
  }

  // Wat uit berichten komt, wordt elke run opnieuw afgeleid; de opgeslagen
  // kopieën van een vorige run laten we dus los.
  const uitBerichten = agendaItemsUitBerichten(berichtRecords, nu).filter(
    (i) => i.eindDag >= eersteDag && i.startDag <= laatsteDag
  );

  const samen = new Map();
  const stats = { nieuw: 0, bijgewerkt: 0, behouden: 0, verdwenen: 0, verlopen: 0, uitBerichten: uitBerichten.length };

  for (const oud of bestaand) {
    if (oud.afkomst === "bericht" || oud.afkomst === "termijn") continue;
    if (nieuw.has(oud.id)) continue;
    if (oud.eindDag < eersteDag) {
      stats.verlopen++;
      continue;
    }
    const dagenNietGezien = (nu.getTime() - new Date(oud.laatstGezienOp).getTime()) / DAG_MS;
    if (oud.eindDag >= vandaag && bronnenMetItems.has(oud.bronId) && dagenNietGezien > AGENDA_VERDWENEN_NA_DAGEN) {
      stats.verdwenen++;
      continue;
    }
    samen.set(oud.id, oud);
    stats.behouden++;
  }
  for (const [id, item] of nieuw) {
    const oud = vorige.get(id);
    if (oud) stats.bijgewerkt++;
    else stats.nieuw++;
    samen.set(id, { ...item, eerstGezienOp: oud && oud.eerstGezienOp ? oud.eerstGezienOp : nu.toISOString() });
  }
  for (const item of uitBerichten) {
    const oud = vorige.get(item.id);
    samen.set(item.id, { ...item, eerstGezienOp: oud && oud.eerstGezienOp ? oud.eerstGezienOp : nu.toISOString() });
  }

  const items = ontdubbelAgenda([...samen.values()]).sort((a, b) => {
    if (a.startDag !== b.startDag) return a.startDag < b.startDag ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.kop.localeCompare(b.kop, "nl");
  });
  stats.zichtbaar = items.filter((i) => i.zichtbaar).length;
  stats.verborgen = items.filter((i) => !i.zichtbaar && !i.inAfwachting).length;
  stats.inAfwachting = items.filter((i) => i.inAfwachting).length;
  return { items, stats };
}

// Zet op elk bericht de ids van de agenda-items die ernaar verwijzen.
function koppelAgendaAanBerichten(records, agendaItems) {
  const perBericht = new Map();
  for (const i of agendaItems) {
    if (!i.berichtId) continue;
    if (!perBericht.has(i.berichtId)) perBericht.set(i.berichtId, []);
    perBericht.get(i.berichtId).push(i.id);
  }
  return records.map((r) => {
    const ids = perBericht.get(r.groepId);
    if (ids && ids.length) return { ...r, agendaIds: ids };
    if (r.agendaIds) {
      const { agendaIds, ...rest } = r;
      void agendaIds;
      return rest;
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// Berichten (de stroom)
// ---------------------------------------------------------------------------

// Is dit een nieuwe versie van een bericht dat we al hebben?
function isBijgewerkt(vorige, titel, lengte) {
  if (opschonen(titel) !== opschonen(vorige.bronTitel)) return true;
  const oud = vorige.bronLengte || 0;
  // Veel korter dan vorige keer: waarschijnlijk is het ophalen van de tekst
  // mislukt en zien we alleen de lijstregel. Geen nieuwe versie.
  if (oud > 0 && lengte < oud * 0.5) return false;
  return Math.abs(lengte - oud) > Math.max(120, oud * 0.08);
}

function publicatieDagVan(b) {
  return kalenderdagAmsterdam(b.gepubliceerdOp) || vandaagAmsterdam();
}

/**
 * De tag van een bericht: een geldige AI-tag, anders trefwoorden in kop en
 * begin van de tekst, anders de standaardtag van de bron, anders Overig.
 * Geeft { tag, bron } met bron "ai" | "trefwoord" | "bron" | "geen".
 */
function kiesTag({ kop, tekst = "", aiTag = null, standaard = ONBEKEND }) {
  return bepaalTag({ kop, tekst, aiTag, standaard, codes: TAG_CODES, namen: TAG_NAMEN });
}

function maakBerichtRecord(b, profiel, versie, tekst, nu, opties = {}) {
  const groepId = korteId(b.url);
  const isUpdate = versie > 1;
  const tag = kiesTag({ kop: b.titel, tekst, standaard: profiel.rubriek });
  const record = {
    id: `${groepId}-v${versie}`,
    groepId,
    versie,
    url: b.url,
    kop: schoneKop(b.titel),
    tekst: null,
    rubriek: tag.tag,
    tagBron: tag.bron,
    herkomst: profiel.herkomst,
    prio: profiel.prio,
    // Bij een update is "tijd" het moment waarop wij de wijziging zagen.
    tijd: isUpdate ? nu.toISOString() : b.gepubliceerdOp,
    heeftTijd: isUpdate ? true : heeftEchteTijd(b.gepubliceerdOp),
    woorden: opties.seed || !tekst ? null : aantalWoorden(tekst),
    afgekapt: tekst.length >= AFGEKAPT_VANAF_TEKENS,
    bronId: b.bronId,
    bronNaam: b.bronNaam,
    ai: false,
    controle: null,
    eerstGezienOp: nu.toISOString(),
    gecontroleerdOp: nu.toISOString(),
    bronTitel: opschonen(b.titel),
    bronLengte: tekst.length,
    ...(opties.seed ? { seed: true } : {}),
  };
  // Termijnen (zienswijze, bezwaar, beroep, inspraak) uit officiële bronnen.
  if (!opties.seed && (profiel.herkomst === "officieel" || profiel.herkomst === "organisatie")) {
    const termijnen = termijnenUitTekst(tekst, publicatieDagVan(b));
    if (termijnen.length) record.termijnen = termijnen;
  }
  // Zonder AI (geen sleutel, quotum op, aanroep mislukt) bepaalt code een eerste
  // checklist en eerste agendapunten. Dezelfde controles als bij de AI-uitvoer
  // gelden: getallen en datums blijven alleen staan als ze in de bron staan.
  // Een latere AI-beoordeling vervangt deze versie (verwerkMelding).
  if (!opties.seed && tekst) {
    const bron = `${b.titel || ""} ${tekst}`;
    record.checklist = maakChecklist(
      checklistUitPatronen(bron, { nu, gepubliceerdOp: isUpdate ? nu.toISOString() : b.gepubliceerdOp }),
      bron
    );
    record.checklistBron = "patroon";
    const punten = verifieerAgendapunten(agendapuntenUitPatronen(b.titel, tekst), bron, publicatieDagVan(b));
    if (punten.length) {
      record.agendapunten = punten;
      record.agendapuntenBron = "patroon";
    }
  }
  return record;
}

// De AI-aanroep voor dit bericht, of null. "volledig" schrijft een korte
// tekst; "analyse" haalt alleen checklist en agendapunten eruit (voor
// bronnen die we nooit herschrijven).
function maakInvoer(record, b, profiel, tekst) {
  if (tekst.length < MIN_TEKST_VOOR_AI) return null;
  const mag = profiel.herschrijf && profiel.herkomst !== "signaal";
  return {
    id: record.id,
    modus: mag ? "volledig" : "analyse",
    titel: b.titel || "",
    tekst,
    bronNaam: b.bronNaam || "",
    gepubliceerdOp: b.gepubliceerdOp || "",
    publicatieDag: publicatieDagVan(b),
    standaardPrio: profiel.prio,
  };
}

function wilOpnieuw(vorige, invoer) {
  if (!invoer || vorige.seed) return false;
  if (!(vorige.controle === null || vorige.controle === "ai-fout")) return false;
  return invoer.modus === "volledig" ? !vorige.ai : !vorige.analyse;
}

/**
 * Bepaalt welke berichten nieuw zijn, een nieuwe versie hebben of opnieuw
 * een AI-poging nodig hebben. Geeft per bericht { record, invoer }. "invoer"
 * is gevuld als de AI er iets mee mag doen.
 *
 * "bijgewerkteControle" zijn bekende berichten die we deze run opnieuw
 * bekeken en ongewijzigd vonden; zij krijgen een nieuwe gecontroleerdOp.
 *
 * Bij de allereerste run (nog geen berichten.json) wordt de stroom aangevuld
 * met oudere feed-items als kale signalen (alleen kop), zodat het scherm niet
 * leeg begint.
 */
function planBerichten({ vensterBerichten, feedItems = [], bestaand = [], nu = new Date() }) {
  const laatste = new Map();
  for (const r of bestaand) {
    const v = laatste.get(r.url);
    if (!v || r.versie > v.versie) laatste.set(r.url, r);
  }

  const nieuwe = [];
  const bijgewerkteControle = [];
  const stats = { nieuw: 0, update: 0, opnieuw: 0, ongewijzigd: 0, seed: 0 };
  const gezien = new Set();

  for (const b of vensterBerichten) {
    if (!b.url || gezien.has(b.url)) continue;
    gezien.add(b.url);

    const profiel = profielVoor(b.bronId);
    const tekst = opschonen(b.samenvatting);
    const vorige = laatste.get(b.url);

    let versie = 1;
    if (vorige) {
      if (!isBijgewerkt(vorige, b.titel, tekst.length)) {
        // Een eerdere AI-poging kan zijn mislukt (quotum, dagcap, geen
        // sleutel). Zo'n bericht proberen we opnieuw zolang het in het
        // venster valt, onder hetzelfde id. Afgekeurde of te korte teksten
        // niet: dat verandert bij een tweede poging niet.
        const invoer = maakInvoer(vorige, b, profiel, tekst);
        if (wilOpnieuw(vorige, invoer)) {
          nieuwe.push({ record: { ...vorige, gecontroleerdOp: nu.toISOString() }, invoer });
          stats.opnieuw++;
        } else {
          bijgewerkteControle.push({ ...vorige, gecontroleerdOp: nu.toISOString() });
          stats.ongewijzigd++;
        }
        continue;
      }
      versie = vorige.versie + 1;
      stats.update++;
    } else {
      stats.nieuw++;
    }

    const record = maakBerichtRecord(b, profiel, versie, tekst, nu);
    nieuwe.push({ record, invoer: maakInvoer(record, b, profiel, tekst) });
  }

  if (bestaand.length === 0) {
    const vandaag = vandaagAmsterdam();
    for (const item of feedItems) {
      if (!item.url || gezien.has(item.url) || item.soort === "agenda") continue;
      const leeftijd = dagVerschil(kalenderdagAmsterdam(item.gepubliceerdOp), vandaag);
      // 0 en 1 dag oud valt al in het venster van de run zelf.
      if (leeftijd === null || leeftijd < 2 || leeftijd > SEED_MAX_DAGEN) continue;
      gezien.add(item.url);
      const profiel = profielVoor(item.bronId);
      const tekst = opschonen(item.samenvatting);
      nieuwe.push({
        record: maakBerichtRecord(item, profiel, 1, tekst, nu, { seed: true }),
        invoer: null,
      });
      stats.seed++;
    }
  }

  return { nieuwe, bijgewerkteControle, stats };
}

// ---------------------------------------------------------------------------
// De AI-uitvoer controleren en verwerken
// ---------------------------------------------------------------------------

function getallenIn(tekst) {
  return (String(tekst).match(/\d+(?:[.,]\d+)*/g) || []).map((token) => ({
    heel: token.replace(/\D/g, "").replace(/^0+(?=\d)/, ""),
    delen: token.split(/[.,]/).map((d) => d.replace(/^0+(?=\d)/, "")),
  }));
}

/**
 * Staat elk getal uit de uitvoer ook in de bron? "10.15" in de uitvoer is
 * goed als de bron "10:15" heeft; "09:00" in de bron dekt "9 uur".
 */
function cijfersKloppen(uitvoer, bron) {
  const toegestaan = new Set();
  for (const g of getallenIn(bron)) {
    toegestaan.add(g.heel);
    for (const deel of g.delen) toegestaan.add(deel);
  }
  return getallenIn(uitvoer).every(
    (g) => toegestaan.has(g.heel) || (g.delen.length > 1 && g.delen.every((d) => toegestaan.has(d)))
  );
}

// De AI mag de standaardprio van de bron met één stap bijstellen, nooit naar 1.
function begrensPrio(prio, standaard) {
  const laag = Math.max(2, standaard - 1);
  const hoog = Math.min(4, standaard + 1);
  if (!Number.isInteger(prio)) return standaard;
  return Math.min(hoog, Math.max(laag, prio));
}

// Alle getallen in een tekst als waarde, ook "2,5 miljoen" en "1.200.000".
function waardenInBron(bron) {
  const waarden = [];
  const re = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s*(miljoen|miljard|mln|mld|duizend)?/gi;
  const eenheden = { miljoen: 1e6, mln: 1e6, miljard: 1e9, mld: 1e9, duizend: 1e3 };
  let m;
  while ((m = re.exec(String(bron))) !== null) {
    const heel = Number(m[1].replace(/\./g, ""));
    const basis = m[2] ? Number(`${heel}.${m[2]}`) : heel;
    waarden.push(basis * (eenheden[(m[3] || "").toLowerCase()] || 1));
  }
  return waarden;
}

function getalStaatInBron(n, bron) {
  if (!Number.isFinite(n)) return false;
  const marge = Math.max(0.5, Math.abs(n) * 0.005);
  return waardenInBron(bron).some((w) => Math.abs(w - n) <= marge);
}

const BOOLEAN_VELDEN = ["gevaar", "evacuatieOfNlAlert", "gewondenOfDoden", "bestuurlijkeCrisis", "besluitMetGrootGevolg", "tijdkritisch"];
const GETAL_VELDEN = ["betrokkenen", "geldbedragEuro", "banen"];

/**
 * De checklist van de AI, gecontroleerd. Getallen blijven alleen staan als ze
 * in de bron voorkomen (ook als "2,5 miljoen"); getallen als woord ("twee
 * gewonden") tellen niet mee en worden null. Of iets in de regio speelt
 * bepaalt de code (alert-regels.js), niet de AI.
 */
function maakChecklist(raw, bron) {
  const r = raw && typeof raw === "object" ? raw : {};
  const uit = {};
  for (const veld of BOOLEAN_VELDEN) uit[veld] = r[veld] === true;
  for (const veld of GETAL_VELDEN) {
    const ruw = r[veld];
    const n = typeof ruw === "number" || typeof ruw === "string" ? Number(ruw) : NaN;
    uit[veld] = Number.isFinite(n) && getalStaatInBron(n, bron) ? n : null;
  }
  uit.inRegio = isRegio(bron);
  return uit;
}

function normaliseer(tekst) {
  return String(tekst ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Controleert de agendapunten van de AI. Een punt blijft alleen staan als de
 * datumtekst letterlijk in de bron staat, de datum te berekenen is (met
 * controle op de weekdag), en tijden en plaats ook in de bron voorkomen.
 */
function verifieerAgendapunten(raw, bron, publicatieDag) {
  if (!Array.isArray(raw)) return [];
  const hooi = normaliseer(bron);
  const uit = [];
  for (const ap of raw.slice(0, MAX_AGENDAPUNTEN_PER_BERICHT * 2)) {
    if (!ap || typeof ap.titel !== "string" || typeof ap.datumTekst !== "string") continue;
    if (!ap.titel.trim() || !hooi.includes(normaliseer(ap.datumTekst))) continue;
    const datum = datumUitTekst(ap.datumTekst, publicatieDag);
    if (!datum) continue;

    let start = null;
    let eind = null;
    if (typeof ap.tijd === "string" && ap.tijd.trim() && cijfersKloppen(ap.tijd, bron)) {
      const klok = klokUitTekst(ap.tijd);
      if (klok) start = amsterdamNaarIso(datum.dag, klok[0], klok[1]);
    }
    if (start && typeof ap.eindtijd === "string" && ap.eindtijd.trim() && cijfersKloppen(ap.eindtijd, bron)) {
      const klok = klokUitTekst(ap.eindtijd);
      if (klok) {
        const kandidaat = amsterdamNaarIso(datum.dag, klok[0], klok[1]);
        if (kandidaat > start) eind = kandidaat;
      }
    }
    const plaats =
      typeof ap.plaats === "string" && ap.plaats.trim() && hooi.includes(normaliseer(ap.plaats))
        ? ap.plaats.trim().slice(0, 80)
        : null;
    uit.push({ titel: schoneKop(ap.titel), dag: datum.dag, start, eind, plaats, zekerheid: datum.zekerheid });
    if (uit.length >= MAX_AGENDAPUNTEN_PER_BERICHT) break;
  }
  return uit;
}

/**
 * Verwerkt het resultaat van Gemini voor één bericht.
 * resultaat: { melding: { kop?, tekst?, prio?, checklist?, agendapunten? } }
 *          | { onvoldoende: true } | { fout }
 */
function verwerkMelding({ record, invoer }, resultaat) {
  if (!invoer || !resultaat) return record;
  if (resultaat.fout) return { ...record, controle: "ai-fout" };
  if (resultaat.onvoldoende) return { ...record, controle: "ai-onvoldoende-tekst" };

  const m = resultaat.melding;
  const bron = `${invoer.titel} ${invoer.tekst}`;
  const basis = { ...record, checklist: maakChecklist(m.checklist, bron), checklistBron: "ai" };
  const agendapunten = verifieerAgendapunten(m.agendapunten, bron, invoer.publicatieDag);
  delete basis.agendapuntenBron;
  if (agendapunten.length) basis.agendapunten = agendapunten;
  else delete basis.agendapunten;

  // De tag: een geldige keuze van de AI wint; anders blijft wat trefwoorden of
  // de bron al kozen. Een tag buiten de lijst telt niet.
  const tag = kiesTag({
    kop: invoer.titel,
    tekst: invoer.tekst,
    aiTag: m.tag,
    standaard: profielVoor(record.bronId).rubriek,
  });
  basis.rubriek = tag.tag;
  basis.tagBron = tag.bron;

  if (invoer.modus === "analyse") return { ...basis, analyse: true, controle: "analyse-ok" };

  if (!cijfersKloppen(`${m.kop} ${m.tekst}`, bron)) return { ...basis, controle: "cijfers-afgekeurd" };
  return {
    ...basis,
    kop: schoneKop(m.kop),
    tekst: opschonen(m.tekst),
    prio: begrensPrio(m.prio, invoer.standaardPrio),
    ai: true,
    controle: "cijfers-ok",
  };
}

// ---------------------------------------------------------------------------
// Volgorde voor de AI
// ---------------------------------------------------------------------------

/**
 * Met een klein quotum komt niet elk bericht aan bod, dus de volgorde telt:
 *  1. officiële en signaalberichten met prio 3 of hoger (de checklists van
 *     signaalbronnen voeden de alerts);
 *  2. de rest van de officiële en signaalberichten;
 *  3. routine, zoals bekendmakingen, alleen als er ruimte over is.
 * Binnen een groep gaat het nieuwste bericht voor. Geeft een nieuwe lijst
 * terug; de invoer blijft ongewijzigd.
 */
function sorteerVoorAI(nieuwe) {
  const rang = (n) => {
    const r = n.record;
    const belangrijk = (r.prio ?? 4) <= 3;
    const wire = r.herkomst === "signaal" || r.herkomst === "officieel";
    return (belangrijk ? 0 : 2) + (wire ? 0 : 1);
  };
  return nieuwe
    .map((n, i) => ({ n, i, rang: rang(n) }))
    .sort((a, b) => a.rang - b.rang || new Date(b.n.record.tijd) - new Date(a.n.record.tijd) || a.i - b.i)
    .map((x) => x.n);
}

// ---------------------------------------------------------------------------
// Samenvoegen en opruimen
// ---------------------------------------------------------------------------

function nieuwsteEerst(a, b) {
  const ta = new Date(a.tijd).getTime();
  const tb = new Date(b.tijd).getTime();
  if (ta !== tb) return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
  const ga = new Date(a.eerstGezienOp).getTime();
  const gb = new Date(b.eerstGezienOp).getTime();
  if (ga !== gb) return (isNaN(gb) ? 0 : gb) - (isNaN(ga) ? 0 : ga);
  return (b.versie || 1) - (a.versie || 1);
}

function voegBerichtenSamen(bestaand, nieuwe, nu = new Date()) {
  const perId = new Map();
  for (const r of bestaand) perId.set(r.id, r);
  for (const r of nieuwe) perId.set(r.id, r);

  const grens = nu.getTime() - BERICHTEN_MAX_DAGEN * DAG_MS;
  let lijst = [...perId.values()].filter((r) => {
    const t = new Date(r.tijd).getTime();
    return isNaN(t) || t >= grens;
  });
  lijst.sort(nieuwsteEerst);
  if (lijst.length > BERICHTEN_MAX_AANTAL) lijst = lijst.slice(0, BERICHTEN_MAX_AANTAL);
  return lijst;
}

module.exports = {
  AGENDA_TERUG_DAGEN,
  AGENDA_VOORUIT_DAGEN,
  BERICHTEN_MAX_DAGEN,
  BERICHTEN_MAX_AANTAL,
  MIN_TEKST_VOOR_AI,
  bouwAgenda,
  agendaTeVerrijken,
  koppelAgendaAanBerichten,
  planBerichten,
  verwerkMelding,
  voegBerichtenSamen,
  sorteerVoorAI,
  kiesTag,
  TAG_CODES,
  TAG_NAMEN,
  // hieronder alleen exporteren voor tests
  cijfersKloppen,
  begrensPrio,
  isBijgewerkt,
  tijdUitTekst,
  statusUitTitel,
  splitsAgendaTitel,
  amsterdamNaarIso,
  amsterdamTijd,
  heeftEchteTijd,
  aantalWoorden,
  maakAgendaItem,
  maakChecklist,
  verifieerAgendapunten,
  getalStaatInBron,
  agendaItemsUitBerichten,
  ontdubbelAgenda,
};
