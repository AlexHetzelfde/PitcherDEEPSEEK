// patronen.js
//
// ZANP: wat code zelf uit een brontekst kan halen, zonder AI en zonder quotum.
//
// WAAROM
// Het gratis Gemini-quotum is klein. Als de AI niet draait (geen sleutel,
// quotum op, aanroep mislukt, cap bereikt) moet de nieuwsdienst toch bruikbaar
// blijven. Dit bestand levert dan een eerste versie van twee dingen:
//
//   1. een checklist met feiten (gevaar, evacuatie, gewonden, getallen) voor
//      de alert-regels;
//   2. agendapunten (inloopavond, hoorzitting, open dag) met een datum die
//      letterlijk in de tekst staat.
//
// De uitkomst gaat daarna door dezelfde controles als de AI-uitvoer
// (maakChecklist en verifieerAgendapunten in wire.js): getallen blijven alleen
// staan als ze in de bron staan, datums alleen als de datumtekst in de bron
// staat en de weekdag klopt. Zodra de AI het bericht later wel beoordeelt,
// vervangt zijn uitkomst deze versie.
//
// BEWUST VOORZICHTIG
// Een vals alarm kost meer vertrouwen dan een gemist alarm. "tijdkritisch" wordt
// dus alleen waar als er een duidelijk gevaarwoord in staat EN het bericht
// jong is. Alerts staan bovendien standaard in logmodus (ALERT_MODUS=log).

const { vindDatumTekst } = require("./agenda-regels");

const W = (inhoud) => new RegExp(`(?<![\\p{L}\\d])(?:${inhoud})(?![\\p{L}\\d])`, "iu");

const EVACUATIE = W("nl-alert|evacuatie|ge[eë]vacueerd|ontruiming|ontruimd|ontruimen|evacueren");
const GEWONDEN = W("gewonden?|gewond geraakt|slachtoffers?|overleden|dodelijk\\w*|doden|omgekomen|levenloos");
const GEVAAR = W(
  "gaslek|explosie|uitslaande brand|grote brand|zeer grote brand|instortingsgevaar|instorting|giftige\\w*|rookwolk|gevaarlijke stoffen|asbestbrand"
);
const BESTUURLIJKE_CRISIS = W(
  "treedt af|aftreden|stapt op|opgestapt|motie van wantrouwen|coalitiebreuk|coalitiecrisis|integriteitsonderzoek|geschorst|schorsing van de wethouder|schorsing van de burgemeester"
);
const GROOT_BESLUIT = W(
  "sluiting van|gaat dicht|sluit de deuren|wordt gesloten|belastingverhoging|ozb-verhoging|verhoging van de ozb|verhoging van de afvalstoffenheffing"
);

const TIJDKRITISCH_UREN = 6;

// "12 gewonden", "40 bewoners", "200 mensen"
const BETROKKENEN = /(?<![\d.,])(\d{1,6})\s+(?:gewonden|slachtoffers|doden|personen|mensen|bewoners|inzittenden|kinderen|woningen)\b/gi;
const BANEN = /(?<![\d.,])(\d{1,6})\s+(?:banen|arbeidsplaatsen|medewerkers)\b/gi;
// "€ 2,5 miljoen", "2,5 miljoen euro", "€ 1.200.000"
const BEDRAG_VOOR = /€\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s*(miljoen|miljard|mln|mld)?/gi;
const BEDRAG_NA = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s*(miljoen|miljard|mln|mld)\s+euro/gi;

const EENHEDEN = { miljoen: 1e6, mln: 1e6, miljard: 1e9, mld: 1e9 };

function grootsteGetal(tekst, regex) {
  regex.lastIndex = 0;
  let max = null;
  let m;
  while ((m = regex.exec(tekst)) !== null) {
    const n = Number(m[1].replace(/\./g, ""));
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

function grootsteBedrag(tekst) {
  let max = null;
  for (const regex of [BEDRAG_VOOR, BEDRAG_NA]) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(tekst)) !== null) {
      const heel = Number(m[1].replace(/\./g, ""));
      const basis = m[2] ? Number(`${heel}.${m[2]}`) : heel;
      const euro = basis * (EENHEDEN[(m[3] || "").toLowerCase()] || 1);
      if (Number.isFinite(euro) && (max === null || euro > max)) max = Math.round(euro);
    }
  }
  return max;
}

/**
 * Een eerste checklist uit de brontekst, in dezelfde vorm als het AI-antwoord.
 * maakChecklist (wire.js) controleert de getallen daarna tegen de bron.
 *
 * @param {string} bron          titel en tekst van de bron
 * @param {object} [opties]      { nu: Date, gepubliceerdOp: ISO } voor "tijdkritisch"
 */
function checklistUitPatronen(bron, opties = {}) {
  const t = String(bron ?? "");
  const evacuatie = EVACUATIE.test(t);
  const gewonden = GEWONDEN.test(t);
  const gevaar = GEVAAR.test(t);

  let jong = false;
  if (opties.gepubliceerdOp) {
    const nu = (opties.nu || new Date()).getTime();
    const tijd = new Date(opties.gepubliceerdOp).getTime();
    jong = Number.isFinite(tijd) && nu - tijd <= TIJDKRITISCH_UREN * 3600 * 1000 && tijd <= nu + 3600 * 1000;
  }

  return {
    gevaar,
    evacuatieOfNlAlert: evacuatie,
    gewondenOfDoden: gewonden,
    betrokkenen: grootsteGetal(t, BETROKKENEN),
    geldbedragEuro: grootsteBedrag(t),
    banen: grootsteGetal(t, BANEN),
    bestuurlijkeCrisis: BESTUURLIJKE_CRISIS.test(t),
    besluitMetGrootGevolg: GROOT_BESLUIT.test(t),
    tijdkritisch: jong && (evacuatie || gevaar || gewonden),
  };
}

// Woorden waaraan je een bijeenkomst of evenement herkent.
const AGENDA_WOORDEN = [
  "inloopavond", "inloopbijeenkomst", "inloopspreekuur", "informatieavond", "informatiebijeenkomst",
  "informatiemarkt", "inspraakavond", "inspraakbijeenkomst", "bewonersavond", "bewonersbijeenkomst",
  "hoorzitting", "openbare vergadering", "raadsvergadering", "commissievergadering", "open dag", "opendag",
  "spreekuur", "themabijeenkomst", "buurtbijeenkomst", "wijkavond", "kijkdag", "open huis", "opening",
];
const AGENDA_REGEX = new RegExp(`(?<![\\p{L}\\d])(${AGENDA_WOORDEN.join("|")})(?![\\p{L}\\d])`, "iu");

const PLAATS_REGEX = /\b(?:in|bij|aan de|op het|in het|in de)\s+((?:het |de )?[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,3})/u;
const TIJD_REGEX = /\b(\d{1,2}[.:]\d{2})\s*uur\b|\bom\s+(\d{1,2}[.:]\d{2})\b|\b(\d{1,2}\s*uur)\b/i;
const TIJD_BEREIK = /(\d{1,2}[.:]\d{2})\s*(?:uur\s*)?(?:-|–|—|tot)\s*(\d{1,2}[.:]\d{2})\s*uur?/i;

function zinnen(tekst) {
  return String(tekst ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“‘(])/u)
    .map((z) => z.trim())
    .filter(Boolean);
}

function hoofdletter(tekst) {
  return tekst ? tekst[0].toUpperCase() + tekst.slice(1) : tekst;
}

/**
 * Agendapunten uit een brontekst: een zin met een bijeenkomstwoord en een
 * datum die letterlijk in die zin staat. Geeft dezelfde vorm als het AI-antwoord
 * (titel, datumTekst, tijd, eindtijd, plaats); verifieerAgendapunten controleert
 * de uitkomst daarna tegen de bron en rekent de datum uit.
 */
function agendapuntenUitPatronen(titel, tekst, max = 3) {
  const uit = [];
  const gezien = new Set();
  for (const zin of zinnen(`${titel ? `${titel}. ` : ""}${tekst || ""}`)) {
    const woord = zin.match(AGENDA_REGEX);
    if (!woord) continue;
    const datumTekst = vindDatumTekst(zin);
    if (!datumTekst) continue;
    const sleutel = `${woord[1].toLowerCase()}|${datumTekst.toLowerCase()}`;
    if (gezien.has(sleutel)) continue;
    gezien.add(sleutel);

    const bereik = zin.match(TIJD_BEREIK);
    const tijd = bereik ? bereik[1] : (zin.match(TIJD_REGEX) || [])[1] || (zin.match(TIJD_REGEX) || [])[2] || null;
    const plaats = (zin.match(PLAATS_REGEX) || [])[1] || null;
    const kop = String(titel ?? "").trim();
    const kopNoemtHetAl = kop && kop.toLowerCase().includes(woord[1].toLowerCase());
    uit.push({
      titel: kopNoemtHetAl ? kop : hoofdletter(woord[1].toLowerCase()) + (kop ? ` — ${kop}` : ""),
      datumTekst,
      tijd: tijd ? `${tijd} uur` : null,
      eindtijd: bereik ? `${bereik[2]} uur` : null,
      plaats,
    });
    if (uit.length >= max) break;
  }
  return uit;
}

module.exports = { checklistUitPatronen, agendapuntenUitPatronen, TIJDKRITISCH_UREN, AGENDA_WOORDEN };
