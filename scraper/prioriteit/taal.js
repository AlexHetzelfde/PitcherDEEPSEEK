// prioriteit/taal.js
//
// Taalverwerking voor de prioriteitsfunctie: tekst wordt omgezet in "termen"
// (stammen van woorden, eigennamen, samenstellingen, bedragen, aantallen
// getroffenen en impactwoorden). Geen AI, geen netwerk.

"use strict";

const IMPACT = require("./impact");

const STOP = new Set(
  `de het een en van in op te dat die dit deze er is zijn was waren wordt worden werd werden heeft hebben had hadden
  hij zij ze wij we ik jij je u hun hen hem haar ons onze uw mijn hier daar waar wie wat welke dan toen als of maar
  want dus ook nog wel niet geen naar bij aan uit met voor over onder door tot om tegen na tussen binnen buiten
  zonder sinds tijdens volgens per via al reeds nu toch zo meer meest minder veel weinig alle alles andere anders
  eigen zelf zelfs kan kunnen kon konden zal zullen zou zouden moet moeten mag mogen wil willen gaat gaan ging
  gingen komt komen kwam kwamen doen doet deed gedaan maakt maken gemaakt jaar jaren dag dagen week weken maand
  maanden uur uren januari februari maart april mei juni juli augustus september oktober november december maandag
  dinsdag woensdag donderdag vrijdag zaterdag zondag eerste tweede derde laatste nieuwe nieuw groot grote kleine
  goed goede beter beste ander daarbij daarom daarnaast echter bijvoorbeeld ligt liggen staat staan stond stonden
  geeft geven gegeven krijgt krijgen kreeg aldus volgende vorige huidige afgelopen komende vanaf vanuit vanwege
  waarbij waarvan waarmee daarvan hiervan ervan eraan erover ervoor erbij ernaar ermee ertoe ieder iedere elke elk
  sommige enkele zoals zodat omdat hoewel terwijl nadat voordat zodra totdat indien mits dient dienen`
    .split(/\s+/)
    .filter(Boolean)
);

function schoon(tekst) {
  return String(tekst || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function ruweWoorden(tekst) {
  return schoon(tekst).match(/[a-z0-9]+/g) || [];
}

// Lichte Nederlandse stemmer: meervouden en klinkerverdubbeling
// (straat/straten, boom/bomen). Het hoeft geen perfect Nederlands te zijn,
// alleen consequent: dezelfde regels gelden voor zoekwoord en stuk.
function stam(w) {
  let s = w;
  if (s.length >= 6 && s.endsWith("en")) s = s.slice(0, -2);
  else if (s.length >= 5 && s.endsWith("s") && !/(ss|us|is|os|as)$/.test(s)) s = s.slice(0, -1);
  else if (s.length >= 6 && s.endsWith("e")) s = s.slice(0, -1);
  s = s.replace(/([aeou])\1/g, "$1");
  s = s.replace(/([bdfgklmnprstvz])\1$/, "$1");
  return s;
}

function stammen(tekst) {
  const uit = [];
  for (const w of ruweWoorden(tekst)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue;
    uit.push(stam(w));
  }
  return uit;
}

function unieke(lijst) {
  return [...new Set(lijst)];
}

const ALGEMEEN = new Set(
  `gemeente gemeentelijk zaanstad zaandam zaanse zaanstreek zaan wormerland oostzaan wormerveer krommenie koog
  zaandijk assendelft westzaan haarlem amsterdam purmerend noord holland provincie nederland nederlandse regio
  wethouder burgemeester college raad gemeenteraad raadslid raadsleden inwoner inwoners bewoner bewoners orkaan
  waarheen nieuws bericht informatie mogelijk project plan stad dorp wijk buurt`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => stam(schoon(w)))
);

// Soorten besluiten en bijeenkomsten: zeggen wat voor stuk het is, niet waarover.
const SOORT_SEED = new Set(
  `besluit verkeersbesluit vergunning omgevingsvergunning evenementenvergunning aanvraag melding bekendmaking boete
  bestuurlijke dwangsom bestuursdwang bezwaar beroep uitnodiging bijeenkomst vergadering informatieve
  themabijeenkomst werkbezoek symposium webinar overleg locatie plaatsen wijzigen verlenen weigeren intrekken
  ontheffing kapvergunning exploitatievergunning`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => stam(schoon(w)))
);

// Organisaties die stukken publiceren. Hun naam staat in al hun stukken en zegt
// dus niets over het onderwerp: zo'n woord is nooit een anker (zie analyse.js).
const ORG_SEED = new Set(
  `vervoerregio omgevingsdienst noordzeekanaalgebied hhnk bkz hoogheemraadschap hollands noorderkwartier rechtspraak
  rechtbank rijksoverheid ibabs deorkaan orkaan waarheen`
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => stam(schoon(w)))
);

// Hoofdwoorden voor het splitsen van samenstellingen (Westerwateringtunnel =
// Westerwatering + tunnel).
const KOPPEN = [
  "tunnel", "brug", "weg", "straat", "plein", "school", "park", "kade", "pad", "laan", "dijk", "plan", "fiets",
  "bus", "trein", "station", "haven", "water", "gebouw", "huis", "wijk", "buurt", "centrum", "terrein", "kanaal",
  "sluis", "vaart", "polder", "molen", "kerk", "hal", "bad", "zaal", "markt", "fabriek", "bedrijf", "project",
  "route", "lijn", "bos", "plas", "meer", "dorp", "stad", "vergunning", "besluit",
].map((w) => stam(schoon(w)));

function deelTermen(s) {
  if (s.length < 9 || s.includes("_")) return [];
  let beste = null;
  for (const kop of KOPPEN) {
    if (kop.length < 3 || !s.endsWith(kop) || s.length - kop.length < 4) continue;
    let links = s.slice(0, s.length - kop.length);
    if (links.length > 4 && links.endsWith("s")) links = links.slice(0, -1);
    if (links.length < 4) continue;
    if (!beste || kop.length > beste[1].length) beste = [links, kop];
  }
  return beste || [];
}

// Eigennamen: hoofdletterwoorden die niet het eerste woord van een zin zijn,
// en afkortingen (BKZ, HHNK). Twee namen achter elkaar ("Dik Trompad") geven
// ook een gecombineerde term.
const NAAMWOORD = /[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9]*/g;

function vindNamen(tekst) {
  const eenheden = new Map();
  const paren = new Map();
  for (const zin of String(tekst || "").split(/(?<=[.!?:;])\s+|[\r\n]+/)) {
    const toks = zin.match(NAAMWOORD) || [];
    let reeks = [];
    const sluit = () => {
      for (let i = 0; i < reeks.length - 1; i++) {
        const t = `${reeks[i]}_${reeks[i + 1]}`;
        paren.set(t, (paren.get(t) || 0) + 1);
      }
      reeks = [];
    };
    toks.forEach((tok, i) => {
      const laag = schoon(tok);
      const isAfkorting = tok.length >= 3 && tok === tok.toUpperCase() && /[A-Z]/.test(tok);
      const hoofd = /^[A-ZÀ-Ý]/.test(tok);
      const isNaam = laag.length >= 3 && !STOP.has(laag) && !/^\d+$/.test(laag) && ((hoofd && i > 0) || isAfkorting);
      if (isNaam) {
        const s = stam(laag);
        reeks.push(s);
        eenheden.set(s, (eenheden.get(s) || 0) + 1);
      } else sluit();
    });
    sluit();
  }
  return { eenheden, paren };
}

function naarGetal(tekst) {
  const n = Number(String(tekst).replace(/[.\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function grootsteBedrag(tekst) {
  let max = 0;
  const f1 = /€\s?(\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?:\s?(miljoen|miljard|mln|mld|duizend))?/gi;
  const f2 = /(\d+(?:,\d+)?)\s?(miljoen|miljard)\s?euro/gi;
  const maal = (e) => {
    const x = String(e || "").toLowerCase();
    if (x === "miljoen" || x === "mln") return 1e6;
    if (x === "miljard" || x === "mld") return 1e9;
    if (x === "duizend") return 1e3;
    return 1;
  };
  let m;
  while ((m = f1.exec(tekst))) max = Math.max(max, naarGetal(m[1]) * maal(m[2]));
  while ((m = f2.exec(tekst))) max = Math.max(max, naarGetal(m[1]) * maal(m[2]));
  return max;
}

function grootsteAantalGetroffenen(tekst) {
  let max = 0;
  const f =
    /(\d{1,3}(?:\.\d{3})*|\d+)\s+(woningen|huizen|bewoners|inwoners|huishoudens|gezinnen|mensen|leerlingen|studenten|personen|slachtoffers|gewonden|reizigers|passagiers|bedrijven|werknemers|banen)/gi;
  let m;
  while ((m = f.exec(tekst))) max = Math.max(max, naarGetal(m[1]));
  return max;
}

// Telt impactwoorden per categorie (orde, conflict, besluit, voorziening) en
// voegt geld en aantal getroffenen toe als categorie.
function telImpact(stamLijst, bedragMax, getroffenMax) {
  const uit = { orde: 0, conflict: 0, besluit: 0, voorziening: 0, geld: 0, aantal: 0 };
  for (const s of stamLijst) {
    const cat = IMPACT.categorieVan(s);
    if (cat) uit[cat] += 1;
  }
  uit.geld = bedragMax >= 1e6 ? 3 : bedragMax >= 1e5 ? 1 : 0;
  uit.aantal = getroffenMax >= 100 ? 3 : getroffenMax >= 20 ? 1 : 0;
  return uit;
}

const AFGELAST = /\b(geannuleerd|afgelast|gaat niet door)\b/;

/**
 * Analyseert één stuk (kop + volledige tekst).
 * Geeft de termen terug waarmee gematcht en gerekend wordt.
 */
function analyseer({ kop = "", tekst = "" }) {
  const lichaam = String(tekst || "");
  const kopTekst = String(kop || "");
  const woorden = Math.max(1, (lichaam.match(/\S+/g) || []).length);

  const lichaamStammen = stammen(lichaam);
  const kopLijst = stammen(kopTekst);
  const telling = new Map();
  for (const s of lichaamStammen) telling.set(s, (telling.get(s) || 0) + 1);

  const intro = lichaam.split(/\s+/).slice(0, 80).join(" ");
  const kopNamen = vindNamen(kopTekst);
  const introNamen = vindNamen(intro);
  const lichaamNamen = vindNamen(lichaam);

  const namen = new Set([...kopNamen.eenheden.keys(), ...lichaamNamen.eenheden.keys()]);
  const paren = new Map();
  for (const m of [kopNamen.paren, lichaamNamen.paren]) {
    for (const [k, v] of m) paren.set(k, (paren.get(k) || 0) + v);
  }
  for (const [k, v] of paren) telling.set(k, v);

  const kopStammen = unieke([...kopLijst, ...kopNamen.paren.keys()]);
  const introStammen = unieke([...stammen(intro), ...introNamen.paren.keys()]);

  const bedragMax = grootsteBedrag(`${kopTekst} ${lichaam}`);
  const getroffenMax = grootsteAantalGetroffenen(`${kopTekst} ${lichaam}`);
  const impact = telImpact([...lichaamStammen, ...kopLijst], bedragMax, getroffenMax);

  const zin = (lichaam.match(/[^.!?\n]{40,}[.!?]/) || [""])[0].trim().slice(0, 200);

  // Geannuleerd of afgelast, volgens de kop of de eerste regels van het stuk zelf.
  const afgelast = AFGELAST.test(schoon(`${kopTekst} ${lichaam.slice(0, 400)}`));

  return { woorden, telling, kopStammen, introStammen, namen, impact, bedragMax, getroffenMax, kern: zin, afgelast };
}

module.exports = {
  STOP,
  ALGEMEEN,
  ORG_SEED,
  SOORT_SEED,
  AFGELAST,
  schoon,
  stam,
  stammen,
  deelTermen,
  vindNamen,
  analyseer,
};
