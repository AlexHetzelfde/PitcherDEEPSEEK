// wire.js
//
// ZANP-ronde (2026-10-23): de persdienst-laag bovenop de bestaande scraper.
//
// Dit bestand maakt twee databestanden die de nieuwe frontend leest:
//   data/berichten.json  de stroom: kop, korte tekst, rubriek, prio, versie
//   data/agenda.json     de weekagenda: begin- en eindtijd, status, doorlopend
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
const { profielVoor } = require("./rubrieken");

const DAG_MS = 24 * 60 * 60 * 1000;

const AGENDA_TERUG_DAGEN = 7;
const AGENDA_VOORUIT_DAGEN = 21;
const AGENDA_VERDWENEN_NA_DAGEN = 3;

const BERICHTEN_MAX_DAGEN = 30;
const BERICHTEN_MAX_AANTAL = 1500;
const SEED_MAX_DAGEN = 7;

const MIN_TEKST_VOOR_AI = 80;
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

/**
 * Bouwt de agenda uit ALLE gescrapete agenda-items (dus ook die van de
 * komende weken), voegt ze samen met de vorige agenda.json en ruimt op:
 *  - verlopen items (meer dan AGENDA_TERUG_DAGEN dagen geleden) gaan weg;
 *  - toekomstige items die de bron al AGENDA_VERDWENEN_NA_DAGEN dagen niet
 *    meer toont, gaan weg (afgelast of van de pagina gehaald). Alleen als
 *    de bron deze run wel iets opleverde, zodat een kapotte scraper geen
 *    agenda leegmaakt.
 */
function bouwAgenda({ ruweBerichten, bronPerId, bestaand = [], nu = new Date() }) {
  const vandaag = vandaagAmsterdam();
  const eersteDag = volgendeDag(vandaag, -AGENDA_TERUG_DAGEN);
  const laatsteDag = volgendeDag(vandaag, AGENDA_VOORUIT_DAGEN);

  const nieuw = new Map();
  const bronnenMetItems = new Set();
  for (const b of ruweBerichten) {
    const bron = bronPerId[b.bronId];
    if (!bron || bron.soort !== "agenda" || !b.url) continue;
    bronnenMetItems.add(b.bronId);
    const item = maakAgendaItem(b, nu);
    if (!item) continue;
    if (item.eindDag < eersteDag || item.startDag > laatsteDag) continue;
    nieuw.set(item.id, item);
  }

  const vorige = new Map(bestaand.map((i) => [i.id, i]));
  const samen = new Map();
  const stats = { nieuw: 0, bijgewerkt: 0, behouden: 0, verdwenen: 0, verlopen: 0 };

  for (const oud of bestaand) {
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

  const items = [...samen.values()].sort((a, b) => {
    if (a.startDag !== b.startDag) return a.startDag < b.startDag ? -1 : 1;
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.kop.localeCompare(b.kop, "nl");
  });
  return { items, stats };
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

function maakBerichtRecord(b, profiel, versie, tekst, nu, opties = {}) {
  const groepId = korteId(b.url);
  const isUpdate = versie > 1;
  return {
    id: `${groepId}-v${versie}`,
    groepId,
    versie,
    url: b.url,
    kop: schoneKop(b.titel),
    tekst: null,
    rubriek: profiel.rubriek,
    soort: profiel.soort,
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
    bronTitel: opschonen(b.titel),
    bronLengte: tekst.length,
    ...(opties.seed ? { seed: true } : {}),
  };
}

/**
 * Bepaalt welke berichten nieuw zijn of een nieuwe versie hebben.
 * Geeft per bericht { record, invoer }. "invoer" is gevuld als de AI er een
 * korte tekst van mag maken (herschrijf-bron én genoeg brontekst).
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
        const opnieuw =
          profiel.herschrijf &&
          tekst.length >= MIN_TEKST_VOOR_AI &&
          !vorige.ai &&
          !vorige.seed &&
          (vorige.controle === null || vorige.controle === "ai-fout");
        if (opnieuw) {
          nieuwe.push({
            record: vorige,
            invoer: {
              id: vorige.id,
              titel: b.titel || "",
              tekst,
              bronNaam: b.bronNaam || "",
              gepubliceerdOp: b.gepubliceerdOp || "",
              standaardPrio: profiel.prio,
            },
          });
          stats.opnieuw++;
        } else {
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
    const invoer =
      profiel.herschrijf && tekst.length >= MIN_TEKST_VOOR_AI
        ? {
            id: record.id,
            titel: b.titel || "",
            tekst,
            bronNaam: b.bronNaam || "",
            gepubliceerdOp: b.gepubliceerdOp || "",
            standaardPrio: profiel.prio,
          }
        : null;
    nieuwe.push({ record, invoer });
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

  return { nieuwe, stats };
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

/**
 * Verwerkt het resultaat van Gemini voor één bericht.
 * resultaat: { melding: { kop, tekst, prio } } | { onvoldoende: true } | { fout }
 */
function verwerkMelding({ record, invoer }, resultaat) {
  if (!invoer || !resultaat) return record;
  if (resultaat.fout) return { ...record, controle: "ai-fout" };
  if (resultaat.onvoldoende) return { ...record, controle: "ai-onvoldoende-tekst" };

  const { kop, tekst, prio } = resultaat.melding;
  if (!cijfersKloppen(`${kop} ${tekst}`, `${invoer.titel} ${invoer.tekst}`)) {
    return { ...record, controle: "cijfers-afgekeurd" };
  }
  return {
    ...record,
    kop: schoneKop(kop),
    tekst: opschonen(tekst),
    prio: begrensPrio(prio, invoer.standaardPrio),
    ai: true,
    controle: "cijfers-ok",
  };
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
  planBerichten,
  verwerkMelding,
  voegBerichtenSamen,
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
};
