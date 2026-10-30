// tags.js
//
// ZANP: de tags (kolommen) van de nieuwsdienst en hoe een bericht er een krijgt.
//
// Een tag zegt waar een bericht OVER gaat, niet waar het vandaan komt. Een
// brand bij De Orkaan hoort bij 112 en een voetbalwedstrijd bij sport, welke
// bron het ook meldt. Een bericht krijgt precies één tag, in deze volgorde:
//
//   1. De AI kiest er één uit de gesloten lijst (zelfde aanroep als de melding,
//      dus zonder extra quotum). Een tag die niet in de lijst staat telt niet.
//   2. Zonder AI-tag (geen sleutel, quotum op, aanroep mislukt) kiest een
//      trefwoordenlijst (hieronder), op de kop en het begin van de tekst.
//   3. Geen treffer: de standaardtag van de bron (rubrieken.json).
//   4. Ook die ontbreekt: ALG. Zo'n bericht staat alleen in "ZANP totaal".
//
// Welke tags bestaan, staat in rubrieken.json (de lijst "rubrieken"); hier
// staan alleen de uitleg en trefwoorden per tag. Een tag zonder trefwoorden
// werkt gewoon: hij wordt alleen door de AI of de bron gekozen.
//
// Een trefwoord tussen vierkante haken, zoals [brand], matcht als begin van
// een woord (brand, brandweer, brandstichting). Zonder haken moet het hele
// woord kloppen (file, ns, bus).

const ONBEKEND = "ALG";

// De uitleg die de AI in de prompt krijgt, en de volgorde bij gelijke score
// (de eerste wint). GEM staat laatst: "gemeente" komt in veel koppen voor.
const TAGS = {
  112: {
    hint: "brand, ongeval met hulpdiensten, politie, misdrijf, ontruiming, vermissing, noodsituatie",
    woorden: [
      "brand", "branden", "[brandweer]", "[brandmelding]", "[uitslaande]", "[blussen]", "[ontruim]", "[evacu]", "nl-alert",
      "politie", "[aangehouden]", "[aanhouding]", "[verdacht]", "[steekpartij]", "[overval]", "[inbraak]",
      "[inbreker]", "[vermist]", "[reanimatie]", "ambulance", "[traumahelikopter]", "[explosie]", "gaslek",
      "[schietpartij]", "[schoten]", "[mishandel]", "[drugs]", "[ongeval]", "[ongeluk]", "[hennep]", "[noodsituatie]",
      "[brandstichting]", "[reddingsbrigade]", "[drenkeling]", "[ernstig ongeval]", "[ernstig ongeluk]",
    ],
  },
  VER: {
    hint: "wegafsluiting, omleiding, file, openbaar vervoer, trein, brug, fietspad, verkeersbesluit, parkeren",
    woorden: [
      "[wegafsluiting]", "[afsluiting]", "[omleiding]", "[stremming]", "file", "[verkeer]", "[wegwerk]",
      "[trein]", "[spoor]", "ns", "bus", "bussen", "[bushalte]", "buslijn", "[fietspad]", "[fietsstraat]",
      "[rotonde]", "[kruispunt]", "[snelweg]", "[brug]", "[sluis]", "[parkeer]", "[verkeersbesluit]",
      "[verkeersbord]", "[openbaar vervoer]", "ov", "[halte]", "[tunnel]", "a8", "a7", "n246", "n203",
    ],
  },
  REC: {
    hint: "rechtbank, uitspraak, rechtszaak, veroordeling, hoger beroep",
    woorden: [
      "[rechtbank]", "[rechter]", "[rechtszaak]", "[vonnis]", "[veroordeeld]", "[veroordeling]", "[celstraf]",
      "[taakstraf]", "[strafzaak]", "[hoger beroep]", "[kort geding]", "ecli", "[openbaar ministerie]",
      "[tenlastelegging]", "[vrijgesproken]", "[bestuursrechter]", "[gerechtshof]",
    ],
  },
  SPO: {
    hint: "sport, wedstrijd, competitie, club, toernooi, sporthal of sportpark",
    woorden: [
      "[wedstrijd]", "[competitie]", "[kampioen]", "[voetbal]", "[zaalvoetbal]", "[hockey]", "[basketbal]",
      "[tennis]", "[zwem]", "[schaats]", "[marathon]", "[hardloop]", "[sportclub]", "[sportvereniging]",
      "[trainer]", "[toernooi]", "[sporthal]", "[sportpark]", "[volleybal]", "[atleet]", "[wielren]", "[judo]",
      "[korfbal]", "[handbal]", "[sporter]", "[sportief]", "[sportdag]", "[roeien]", "[zeilen]", "[turnen]", "[darts]",
    ],
  },
  ONW: {
    hint: "school, leerlingen, studenten, onderwijs, kinderopvang, scholenkoepel",
    woorden: [
      "[school]", "[scholen]", "[leerling]", "[docent]", "[onderwijs]", "[basisschool]", "[middelbare]",
      "[mbo]", "[hbo]", "[universiteit]", "[student]", "[kinderopvang]", "[schoolbestuur]", "[scholengemeenschap]",
      "[vo-school]", "[schoolplein]", "[schoolgebouw]", "[lesgeven]", "[schooljaar]", "[examen]", "[diploma]",
      "[lerarentekort]", "[peuterspeelzaal]", "[brede school]", "[ovo]",
    ],
  },
  BED: {
    hint: "bedrijven, ondernemers, winkels, horeca, faillissement, banen, economie",
    woorden: [
      "[faillissement]", "[failliet]", "[ondernemer]", "[bedrijf]", "[winkel]", "[overname]", "[fusie]",
      "[omzet]", "[horeca]", "[restaurant]", "[vestiging]", "[start-up]", "[startup]", "[werkgelegenheid]",
      "[bedrijventerrein]", "[kamer van koophandel]", "[winkelcentrum]", "[ontslag]", "[reorganisatie]",
      "[productie]", "[fabriek]", "[industrie]", "[havenbedrijf]", "[leegstand]", "[winkelstraat]", "[supermarkt]",
    ],
  },
  PRV: {
    hint: "provincie, waterschap, omgevingsdienst, natuur, water, dijken en polders",
    woorden: [
      "[provincie]", "[provinciale]", "[gedeputeerde]", "[waterschap]", "[hoogheemraadschap]", "[hhnk]",
      "[omgevingsdienst]", "natuur", "natuurgebied", "[natuurbeheer]", "[natuurreservaat]", "[natuurmonumenten]", "[stikstof]", "[waterkwaliteit]", "[dijk]", "[polder]", "[peilbeheer]",
      "[watergang]", "[maaiveld]", "[baggeren]", "[gemaal]", "[boezem]", "[natura 2000]", "[veenweide]",
    ],
  },
  CUL: {
    hint: "cultuur, museum, tentoonstelling, concert, theater, erfgoed, molens, evenement",
    woorden: [
      "[museum]", "[tentoonstelling]", "[expositie]", "[concert]", "[theater]", "[voorstelling]", "[festival]",
      "[molen]", "[erfgoed]", "[bibliotheek]", "kunst", "kunstenaar", "[kunstwerk]", "[kunstroute]", "[muziek]", "film", "[cultuur]", "[schilder]",
      "[galerie]", "[lezing]", "[workshop]", "[optreden]", "[dansavond]", "[kermis]",
      "[monument]", "[zaanse schans]", "[podium]", "[cabaret]", "[boekpresentatie]",
    ],
  },
  GEM: {
    hint: "gemeente, gemeenteraad, college, burgemeester, wethouder, besluiten, vergunningen en bekendmakingen",
    woorden: [
      "[gemeente]", "[gemeenteraad]", "[raadsvergadering]", "[college van b]", "[burgemeester]", "[wethouder]",
      "[bestemmingsplan]", "[omgevingsvergunning]", "[verordening]", "[begroting]", "[zienswijze]", "[coalitie]",
      "[raadslid]", "[raadsvoorstel]", "[raadsinformatiebrief]", "[ozb]", "[woningbouw]", "[bouwplan]", "[wijkraad]",
      "[inspraak]", "[collegeberichten]", "[ingekomen stukken]",
    ],
  },
};

const VOLGORDE = Object.keys(TAGS);

function ontsnap(tekst) {
  return tekst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "[brand]" -> begin van een woord; "file" -> heel woord.
function maakRegex(woord) {
  const prefix = woord.startsWith("[") && woord.endsWith("]");
  const kern = ontsnap(prefix ? woord.slice(1, -1) : woord).replace(/\s+/g, "\\s+");
  return new RegExp(prefix ? `(?<![\\p{L}\\d])${kern}` : `(?<![\\p{L}\\d])${kern}(?![\\p{L}\\d])`, "iu");
}

const REGELS = Object.fromEntries(
  VOLGORDE.map((code) => [code, TAGS[code].woorden.map((w) => ({ woord: w, regex: maakRegex(w) }))])
);

const KOP_PUNTEN = 3;
const TEKST_PUNTEN = 1;
const MIN_SCORE = 3;
const TEKST_TEKENS = 600;

/**
 * Kiest een tag op trefwoorden. Een treffer in de kop telt voor 3, een treffer
 * in het begin van de tekst voor 1; er zijn minstens 3 punten nodig, dus één
 * trefwoord in de kop of drie verschillende in de tekst. Bij gelijke stand
 * wint de tag die in VOLGORDE eerder staat.
 *
 * @param {string} kop
 * @param {string} [tekst]
 * @param {Set<string>|string[]} [toegestaan]  alleen tags uit deze lijst
 * @returns {{ tag: string, score: number } | null}
 */
function kiesTagUitTekst(kop, tekst = "", toegestaan = null) {
  const kopTekst = String(kop ?? "");
  const begin = String(tekst ?? "").slice(0, TEKST_TEKENS);
  const mag = toegestaan ? new Set(toegestaan) : null;
  let beste = null;
  for (const code of VOLGORDE) {
    if (mag && !mag.has(code)) continue;
    let score = 0;
    for (const { regex } of REGELS[code]) {
      if (regex.test(kopTekst)) score += KOP_PUNTEN;
      else if (regex.test(begin)) score += TEKST_PUNTEN;
    }
    if (score >= MIN_SCORE && (!beste || score > beste.score)) beste = { tag: code, score };
  }
  return beste;
}

// De AI hoort een code te geven ("SPO"), maar "sport" of "Sport" is ook duidelijk.
function normTag(tekst) {
  return String(tekst ?? "").toLowerCase().replace(/[^\p{L}\d]+/gu, "");
}

function tagUitAntwoord(antwoord, geldig, namen = {}) {
  const gezocht = normTag(antwoord);
  if (!gezocht) return null;
  for (const code of geldig) {
    if (normTag(code) === gezocht) return code;
    const naam = namen[code];
    if (naam && (normTag(naam) === gezocht || normTag(String(naam).split(/[ &,]/)[0]) === gezocht)) return code;
  }
  return null;
}

/**
 * De definitieve tag van een bericht, met de herkomst van die keuze.
 * @param {object} p
 * @param {string} p.kop
 * @param {string} [p.tekst]
 * @param {string|null} [p.aiTag]       tag die de AI koos (wordt gecontroleerd)
 * @param {string} [p.standaard]        standaardtag van de bron
 * @param {string[]} p.codes            alle geldige tags (zonder ALG)
 * @param {object} [p.namen]            code -> naam, zodat "sport" ook geldt voor SPO
 * @returns {{ tag: string, bron: "ai" | "trefwoord" | "bron" | "geen" }}
 */
function bepaalTag({ kop, tekst = "", aiTag = null, standaard = ONBEKEND, codes, namen = {} }) {
  const geldig = new Set(codes);
  const aiCode = tagUitAntwoord(aiTag, geldig, namen);
  if (aiCode) return { tag: aiCode, bron: "ai" };
  const woord = kiesTagUitTekst(kop, tekst, geldig);
  if (woord) return { tag: woord.tag, bron: "trefwoord" };
  if (standaard && standaard !== ONBEKEND && geldig.has(standaard)) return { tag: standaard, bron: "bron" };
  return { tag: ONBEKEND, bron: "geen" };
}

// Voor de prompt: [{ code, naam, hint }], alleen de tags die in rubrieken.json staan.
function tagsVoorPrompt(rubrieken) {
  return (rubrieken || [])
    .filter((r) => r && r.code !== ONBEKEND)
    .map((r) => ({ code: r.code, naam: r.naam, hint: (TAGS[r.code] && TAGS[r.code].hint) || "" }));
}

module.exports = { ONBEKEND, TAGS, VOLGORDE, kiesTagUitTekst, bepaalTag, tagUitAntwoord, tagsVoorPrompt };
