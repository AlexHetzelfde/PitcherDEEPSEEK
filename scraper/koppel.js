// koppel.js
//
// ZANP: berichten en agendapunten koppelen op HARDE SLEUTELS.
//
// Eén zaak staat vaak op meerdere plekken: een bekendmaking over de
// Annemoonstraat 30, de hoorzitting erover in de agenda, het raadsstuk, later
// de uitspraak. Deze module legt die verbanden, deterministisch en zonder AI,
// op sleutels die je niet kunt verzinnen:
//
//   adres      "annemoonstraat 30" (straat + huisnummer)
//   ecli       ECLI:NL:RBNHO:2026:1234
//   zaak       een nummer na "zaaknummer", "kenmerk" of "dossier"
//   olo        OLO 1234567 (omgevingsloket)
//
// Een postcode alleen is te grof (één postcode is een stuk straat) en telt dus
// niet. Een sleutel die in meer dan MAX_FREQUENTIE items voorkomt, wordt
// genegeerd: dat is een gedeeld adres (het stadhuis) en geen zaak.
//
// WAT ER GEKOPPELD WORDT
//   agendapunt -> bericht   het agendapunt toont het bericht erover (berichtId);
//                           het bericht toont het agendapunt via agendaIds
//                           (dat doet koppelAgendaAanBerichten in wire.js).
//   agendapunt -> uitkomst  een bericht dat PAS NA de dag van het agendapunt
//                           verschijnt en dezelfde sleutel heeft, is de uitkomst
//                           (uitkomstId). Zo linkt "hoorzitting verwacht" naar
//                           het besluit dat eruit volgt.
//   bericht -> bericht      "Zie ook": andere berichten over dezelfde zaak
//                           (gerelateerd), hooguit MAX_GERELATEERD.
//
// Een koppeling die hier wordt gelegd draagt gekoppeldVia: "sleutel". Elke run
// worden die opnieuw berekend, zodat een gewijzigde regel of een verdwenen
// bericht nooit een oude koppeling achterlaat.

const MAX_FREQUENTIE = 4;
const MAX_GERELATEERD = 4;
const MAX_MEER_BERICHTEN = 3;

const STRAAT_ACHTER = [
  "straat", "laan", "weg", "plein", "gracht", "kade", "dijk", "singel", "pad", "hof", "steeg", "dreef",
  "baan", "poort", "erf", "plantsoen", "zijde", "buurt", "park", "markt", "burg", "wal", "sloot",
].join("|");

const ADRES = new RegExp(
  // Alleen het straatwoord zelf ("Annemoonstraat"), niet het hoofdletterwoord ervoor:
  // "Aanvraag Annemoonstraat 30" en "Hoorzitting Annemoonstraat 30" moeten dezelfde
  // sleutel geven.
  `([A-ZÀ-Ý][\\p{L}'’-]*(?:${STRAAT_ACHTER}))\\s+(\\d{1,4})([a-zA-Z]{1,2})?(?![\\p{L}\\d])`,
  "gu"
);
const ECLI = /ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9]+/gi;
const ZAAK = /\b(?:zaaknummer|zaak|kenmerk|dossiernummer|dossier|ons kenmerk)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/.]{5,})/gi;
const OLO = /\bOLO[\s-]?(\d{5,8})\b/gi;

function schoon(tekst) {
  return String(tekst ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Alle harde sleutels in een tekst, als Set van "soort:waarde". */
function sleutelsVan(tekst) {
  const t = String(tekst ?? "");
  const uit = new Set();
  for (const m of t.matchAll(ECLI)) uit.add(`ecli:${m[0].toUpperCase()}`);
  for (const m of t.matchAll(OLO)) uit.add(`olo:${m[1]}`);
  for (const m of t.matchAll(ZAAK)) uit.add(`zaak:${m[1].replace(/[.,;]+$/, "").toUpperCase()}`);
  for (const m of t.matchAll(ADRES)) {
    uit.add(`adres:${schoon(m[1])} ${m[2]}${m[3] ? schoon(m[3]) : ""}`);
  }
  return uit;
}

function dagVanIso(iso) {
  return typeof iso === "string" ? iso.slice(0, 10) : "";
}

function nieuwsteVersies(records) {
  const perGroep = new Map();
  for (const r of records) {
    const v = perGroep.get(r.groepId);
    if (!v || (r.versie || 1) > (v.versie || 1)) perGroep.set(r.groepId, r);
  }
  return [...perGroep.values()];
}

/**
 * Legt de koppelingen.
 *
 * @param {object[]} records      alle berichten (alle versies)
 * @param {object[]} agendaItems  de agenda zoals bouwAgenda die teruggeeft
 * @returns {{ records: object[], agendaItems: object[], stats: object }}
 */
function koppelDossiers(records, agendaItems, opties = {}) {
  const maxFrequentie = opties.maxFrequentie ?? MAX_FREQUENTIE;

  // Eerst alle sleutelkoppelingen van vorige runs wissen. uitkomstId en
  // meerBerichten zijn altijd van ons; een berichtId alleen als wij hem legden
  // (gekoppeldVia), want de eigen berichtId van een agendapunt uit een bericht
  // en die van een samengevoegd dubbel zijn van wire.js.
  const items = agendaItems.map((i) => {
    const { uitkomstId, meerBerichten, ...rest } = i;
    void uitkomstId;
    void meerBerichten;
    if (rest.gekoppeldVia !== "sleutel") return rest;
    const { berichtId, gekoppeldVia, ...zonder } = rest;
    void berichtId;
    void gekoppeldVia;
    return zonder;
  });
  const berichten = nieuwsteVersies(records);

  const berichtSleutels = new Map(berichten.map((r) => [r.groepId, sleutelsVan(`${r.kop} ${r.bronTitel || ""} ${r.tekst || ""}`)]));
  const itemSleutels = new Map(items.map((i) => [i.id, sleutelsVan(`${i.kop} ${i.plaats || ""}`)]));

  const frequentie = new Map();
  const tel = (set) => {
    for (const s of set) frequentie.set(s, (frequentie.get(s) || 0) + 1);
  };
  berichtSleutels.forEach(tel);
  itemSleutels.forEach(tel);
  const bruikbaar = (s) => (frequentie.get(s) || 0) <= maxFrequentie;

  const perSleutel = new Map(); // sleutel -> { berichten: [], items: [] }
  const zet = (sleutel, soort, x) => {
    if (!perSleutel.has(sleutel)) perSleutel.set(sleutel, { berichten: [], items: [] });
    perSleutel.get(sleutel)[soort].push(x);
  };
  for (const r of berichten) for (const s of berichtSleutels.get(r.groepId)) if (bruikbaar(s)) zet(s, "berichten", r);
  for (const i of items) for (const s of itemSleutels.get(i.id)) if (bruikbaar(s)) zet(s, "items", i);

  const stats = { agendaNaarBericht: 0, uitkomsten: 0, berichtenGekoppeld: 0 };
  const gerelateerd = new Map(); // groepId -> Set<groepId>

  const itemPerId = new Map(items.map((i) => [i.id, i]));

  for (const { berichten: bs, items: is } of perSleutel.values()) {
    // bericht <-> bericht
    for (const a of bs) {
      for (const b of bs) {
        if (a.groepId === b.groepId) continue;
        if (a.clusterId && a.clusterId === b.clusterId) continue; // hetzelfde nieuwsfeit, geen "zie ook"
        if (!gerelateerd.has(a.groepId)) gerelateerd.set(a.groepId, new Set());
        gerelateerd.get(a.groepId).add(b.groepId);
      }
    }
    // agendapunt <-> bericht
    for (const i of is) {
      const doel = itemPerId.get(i.id);
      for (const b of [...bs].sort((x, y) => String(x.tijd).localeCompare(String(y.tijd)))) {
        if (doel.berichtId === b.groepId || doel.uitkomstId === b.groepId) continue; // al gekoppeld, ook het eigen bericht
        const na = dagVanIso(b.tijd) > (doel.eindDag || doel.startDag);
        if (na) {
          if (!doel.uitkomstId) {
            doel.uitkomstId = b.groepId;
            stats.uitkomsten++;
          }
        } else if (!doel.berichtId) {
          doel.berichtId = b.groepId;
          doel.gekoppeldVia = "sleutel";
          stats.agendaNaarBericht++;
        } else {
          doel.meerBerichten = doel.meerBerichten || [];
          if (doel.meerBerichten.length < MAX_MEER_BERICHTEN && !doel.meerBerichten.includes(b.groepId)) {
            doel.meerBerichten.push(b.groepId);
          }
        }
      }
    }
  }

  const nieuweRecords = records.map((r) => {
    const set = gerelateerd.get(r.groepId);
    const lijst = set ? [...set].slice(0, MAX_GERELATEERD) : [];
    const heeft = Array.isArray(r.gerelateerd) && r.gerelateerd.length > 0;
    if (lijst.length === 0) {
      if (!heeft) return r;
      const { gerelateerd: oud, ...rest } = r;
      void oud;
      return rest;
    }
    if (heeft && JSON.stringify(r.gerelateerd) === JSON.stringify(lijst)) return r;
    return { ...r, gerelateerd: lijst };
  });
  stats.berichtenGekoppeld = [...gerelateerd.keys()].length;

  return { records: nieuweRecords, agendaItems: items, stats };
}

module.exports = { sleutelsVan, koppelDossiers, MAX_FREQUENTIE, MAX_GERELATEERD };
