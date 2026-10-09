// hulpmiddelen.js
// Gedeelde functies die door meerdere scrapers gebruikt worden.

const cheerio = require("cheerio");
const Parser = require("rss-parser");
const rssParser = new Parser();
const tls = require("tls");
const crypto = require("crypto");
const { Agent } = require("undici");

const GEBRUIKERSAGENT =
  "NieuwsaggregatorZaanstreekBot/1.0 (+journalistiek studentenproject; contact via github repo)";

// Centrale leeftijdsgrens: berichten ouder dan dit worden nergens meegenomen.
// Dit staat hier, op ÉÉN plek, en wordt door zowel index.js (als centrale,
// gezaghebbende filter voor ALLE bronnen) als door ibabs.js (als vroege
// filter, vóór het dure documentinhoud-ophalen) gebruikt — nooit los
// gedupliceerd per scraper.
const MAX_LEEFTIJD_DAGEN = 7;

/**
 * True als een datum binnen de leeftijdsgrens valt. Een bericht ZONDER
 * betrouwbaar herkende datum telt hier bewust als "te oud"/niet toegestaan —
 * niet als "onbekend dus maar meenemen". Dat laatste zorgde er in de praktijk
 * voor dat een kapotte datumherkenning van een bron (zoals gebeurde bij de
 * WordPress-fallback en bij één van de iBabs-rapporten) onopgemerkt bleef en
 * alle historische berichten liet doorsijpelen in plaats van alleen recente.
 * Een bron waarvan structureel geen datum wordt herkend, levert nu dus 0
 * berichten op — zichtbaar fout, in plaats van onzichtbaar fout.
 */
function binnenLeeftijdsgrens(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return false;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return false;
  const grens = Date.now() - MAX_LEEFTIJD_DAGEN * 24 * 60 * 60 * 1000;
  return datum.getTime() >= grens;
}

// Agenda-bronnen (bron.soort === "agenda") tonen vooral evenementen die nog moeten
// komen. Daar geldt een eigen venster: niet "maximaal 7 dagen oud", maar "alleen
// evenementen die VANDAAG beginnen". De datum is de datum van het evenement, niet
// van publicatie.
//
// Waarom alleen vandaag: de agenda is vooral bedoeld om unieke, eenmalige
// evenementen op te vangen die op de dag zelf relevant zijn. Langlopende
// evenementen (met een eindDatum) tellen alleen mee als ze vandaag beginnen,
// niet als ze gisteren begonnen zijn en vandaag nog lopen.
//
// De eindDatumIso-parameter wordt niet meer gebruikt in de logica (we kijken
// alleen naar de startdatum), maar blijft in de signatuur staan zodat
// bestaande aanroepen (zoals in bron-poort.js) ongewijzigd blijven werken.
//
// De constanten staan op 0 en zijn alleen nog voor compatibiliteit in de
// export gehouden; de logica hieronder gebruikt ze niet meer.
const AGENDA_MAX_VERLEDEN_DAGEN = 0;
const AGENDA_MAX_VOORUIT_DAGEN = 0;

function binnenAgendaVenster(gepubliceerdOpIso, eindDatumIso) {
  if (!gepubliceerdOpIso) return false;
  const start = new Date(gepubliceerdOpIso).getTime();
  if (isNaN(start)) return false;
  const dag = 24 * 60 * 60 * 1000;
  const nu = new Date();
  const beginVandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate()).getTime();
  const eindVandaag = beginVandaag + dag;
  return start >= beginVandaag && start < eindVandaag;
}

/**
 * Het venster voor één bron: het agenda-venster voor agenda-bronnen, de
 * gewone leeftijdsgrens voor alle andere. index.js gebruikt deze functie voor
 * de centrale filter, zodat elke bron precies één regel krijgt.
 *
 * De derde parameter (eindDatumIso) wordt doorgegeven aan binnenAgendaVenster
 * voor compatibiliteit met bestaande aanroepen; de agenda-logica gebruikt hem
 * niet meer.
 */
function binnenVenster(gepubliceerdOpIso, bron, eindDatumIso) {
  return bron && bron.soort === "agenda" ? binnenAgendaVenster(gepubliceerdOpIso, eindDatumIso) : binnenLeeftijdsgrens(gepubliceerdOpIso);
}

/**
 * Leeftijd van een bericht in dagen (kan een fractie zijn), of null als er
 * geen betrouwbare datum is. Wordt op dit moment nergens meer gebruikt
 * (score.js is verwijderd); bewust nog niet opgeruimd.
 */
function leeftijdInDagen(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return null;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return null;
  return (Date.now() - datum.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Node's ingebouwde fetch (undici) gooit bij netwerkproblemen bijna altijd
 * alleen de generieke `TypeError: fetch failed` als `.message` — de échte
 * reden (DNS, timeout, connectie geweigerd, TLS-probleem, ...) zit dan in
 * `.cause`, die door Node zelf NIET wordt meegeprint met `fout.message`.
 * Deze helper haalt die oorzaak eruit zodat we hem overal waar we een
 * fetch-fout loggen ook echt kunnen zien, in plaats van alleen "fetch
 * failed" zonder verdere context.
 */
function oorzaakTekst(fout) {
  const oorzaak = fout && fout.cause;
  if (!oorzaak) return "";
  const code = oorzaak.code ? ` [${oorzaak.code}]` : "";
  const tekst = oorzaak.message || String(oorzaak);
  return ` — oorzaak: ${tekst}${code}`;
}

/**
 * Sommige servers (met name kleinere overheids-/instellingshosting, zo blijkt
 * bij loket.zaanstad.nl) sturen bij het TLS-handshaken niet hun volledige
 * certificaatketen mee — ze vergeten het tussencertificaat. Een browser merkt
 * dit nooit, want die repareert het stilzwijgend zelf: hij haalt het
 * ontbrekende tussencertificaat op via een link die IN het certificaat zelf
 * staat (de "Authority Information Access"-extensie, "AIA-fetching"). Node
 * doet dat niet, en faalt dan met UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 *
 * Deze functie doet precies wat de browser doet:
 *   1. Verbindt zonder verificatie, puur om het certificaat te lezen.
 *   2. Leest daaruit de CA-Issuers-URL.
 *   3. Haalt het ontbrekende certificaat daar op (bij de CA zelf, niet bij de
 *      oorspronkelijke server — dát certificaat kunnen we dus wél vertrouwen).
 *   4. Geeft een fetch-optie ({ dispatcher }) terug die dat certificaat
 *      toevoegt aan de normale vertrouwde root-certificaten (niet in de
 *      plaats daarvan), zodat verder niets aan vertrouwen inlevert.
 *
 * Geeft null terug als het niet lukt (bv. geen AIA-extensie aanwezig, of de
 * download zelf faalt) — dan blijft de oorspronkelijke fout gewoon staan en
 * verandert er niets aan het bestaande gedrag.
 */
async function probeerKetenTeRepareren(url) {
  const { hostname, port, protocol } = new URL(url);
  const tlsPoort = Number(port) || (protocol === "http:" ? 80 : 443);

  let leafCertRaw;
  try {
    leafCertRaw = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: hostname, port: tlsPoort, servername: hostname, rejectUnauthorized: false, timeout: 10_000 },
        () => {
          const cert = socket.getPeerCertificate(false);
          socket.end();
          resolve(cert && cert.raw);
        }
      );
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("TLS-verbinding voor ketenreparatie liep vast op een timeout"));
      });
    });
  } catch {
    return null;
  }
  if (!leafCertRaw) return null;

  // Volg de "CA Issuers"-link net zoals een browser dat doet: van het
  // certificaat naar zijn uitgever, en van díé weer naar zíjn uitgever,
  // net zo lang tot er geen link meer is (dan zijn we vermoedelijk bij de
  // root aanbeland, die zichzelf ondertekent en dus geen uitgever-link
  // heeft). Zo repareren we niet alleen een ontbrekend tussencertificaat,
  // maar ook het geval waarin zelfs de root nog niet in Node's eigen
  // meegeleverde lijst zit (bijvoorbeeld bij een overheids-PKI).
  const extraCertificaten = [];
  const gebruikteUrls = [];
  let huidigCertRaw = leafCertRaw;
  const MAX_STAPPEN = 5;

  for (let stap = 0; stap < MAX_STAPPEN; stap++) {
    let x509;
    try {
      x509 = new crypto.X509Certificate(huidigCertRaw);
    } catch {
      break;
    }

    const infoAccess = x509.infoAccess || "";
    const match = infoAccess.match(/CA Issuers - URI:(\S+)/);
    if (!match) break; // geen verdere link meer -- keten is klaar
    const issuerUrl = match[1];

    let issuerBuffer;
    try {
      const response = await fetch(issuerUrl);
      if (!response.ok) break;
      issuerBuffer = Buffer.from(await response.arrayBuffer());
    } catch {
      break;
    }

    let issuerPem;
    let issuerRaw;
    try {
      const tekst = issuerBuffer.toString("utf-8");
      if (tekst.includes("BEGIN CERTIFICATE")) {
        issuerPem = tekst;
        issuerRaw = new crypto.X509Certificate(tekst).raw;
      } else {
        const x = new crypto.X509Certificate(issuerBuffer); // DER-formaat
        issuerPem = x.toString();
        issuerRaw = issuerBuffer;
      }
    } catch {
      break;
    }

    extraCertificaten.push(issuerPem);
    gebruikteUrls.push(issuerUrl);
    huidigCertRaw = issuerRaw;
  }

  if (extraCertificaten.length === 0) return null;

  const agent = new Agent({ connect: { ca: [...tls.rootCertificates, ...extraCertificaten] } });
  return { dispatcher: agent, issuerUrl: gebruikteUrls.join(" -> ") };
}

/**
 * Sommige sites (vaak sessie-gebaseerde overheidsportalen of anti-bot-
 * bescherming, zo blijkt ook bij loket.zaanstad.nl) sturen bij het eerste
 * bezoek een sessie-cookie mee en blijven doorverwijzen totdat die cookie
 * wordt teruggestuurd. Een browser doet dat automatisch; Node's fetch() heeft
 * geen ingebouwde cookie-jar en blijft daardoor eindeloos heen-en-weer
 * gestuurd worden, tot hij opgeeft met "redirect count exceeded".
 *
 * Deze functie volgt redirects zelf (net als een browser doet — dus ook
 * bruikbaar in combinatie met een `dispatcher` van probeerKetenTeRepareren,
 * via de optionele `opties`), houdt cookies bij tussen de hops in, en geeft
 * de uiteindelijke pagina-inhoud terug.
 */
async function haalOpMetCookies(url, opties = {}, maxHops = 20) {
  const cookieJar = new Map();
  let huidigeUrl = url;

  for (let hop = 0; hop < maxHops; hop++) {
    const headers = { ...opties.headers };
    if (cookieJar.size > 0) {
      headers["Cookie"] = [...cookieJar].map(([naam, waarde]) => `${naam}=${waarde}`).join("; ");
    }
    const response = await fetch(huidigeUrl, { ...opties, headers, redirect: "manual" });

    const nieuweCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const regel of nieuweCookies) {
      const [naamWaarde] = regel.split(";");
      const gelijkteken = naamWaarde.indexOf("=");
      if (gelijkteken > 0) {
        cookieJar.set(naamWaarde.slice(0, gelijkteken).trim(), naamWaarde.slice(gelijkteken + 1).trim());
      }
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const locatie = response.headers.get("location");
      if (!locatie) throw new Error(`Redirect (${response.status}) zonder Location-header op ${huidigeUrl}`);
      huidigeUrl = new URL(locatie, huidigeUrl).toString();
      continue;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status} voor ${huidigeUrl}`);
    return await response.text();
  }
  throw new Error(`Ook mét cookies nog steeds meer dan ${maxHops} redirects — vermoedelijk een echte lus, geen sessieprobleem`);
}

/**
 * Fallback voor als er géén los datum-element op de pagina staat, maar de
 * datum wel ergens in de tekst zelf verstopt zit — zoals bij de Zaanstad-
 * hoorzittingen, waar de titel letterlijk begint met "2026-09-22 Dinsdag 22
 * september 2026 om 17.15 uur - ...". Gemini herkent dat soort titels dan
 * terecht niet als een apart datum-element (dat is het ook niet), maar we
 * kunnen de datum alsnog uit de tekst zelf halen.
 *
 * Probeert eerst een ISO-datum (YYYY-MM-DD, vaak als machine-leesbare
 * sorteersleutel vooraan de tekst), dan een Nederlandse "22 september
 * 2026"-vorm, en alleen met { zonderJaar: true } ook "30 sep" of "30 september"
 * zonder jaar (zie haalDatumZonderJaar). Geeft null terug als niets herkend wordt.
 *
 * Let op de grenzen: er staat bewust (?<!\d) en (?!\d) in plaats van \b. Bij
 * tekst uit HTML zonder spaties ("1 oktober 2026Evenement 2: ...") zit er
 * geen woordgrens tussen het cijfer en de letter, waardoor \b de datum miste.
 */
const NEDERLANDSE_MAANDEN = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

const MAANDEN_LANG = "januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december";
// Afkortingen zoals agenda's ze schrijven ("30 sep", "1 okt", "12 mrt").
const MAANDEN_KORT = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, okt: 9, nov: 10, dec: 11 };
const MAAND_ALLES = `${MAANDEN_LANG}|jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec`;

function haalDatumUitTekst(tekst, opties = {}) {
  if (!tekst) return null;

  const iso = tekst.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const nl = tekst.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MAANDEN_LANG})\\s+(\\d{4})(?!\\d)`, "i"));
  if (nl) {
    const maand = NEDERLANDSE_MAANDEN[nl[2].toLowerCase()];
    const d = new Date(Number(nl[3]), maand, Number(nl[1]));
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  if (opties.zonderJaar) return haalDatumZonderJaar(tekst, opties.nu);
  return null;
}

/**
 * Leest een datum zonder jaartal ("30 sep", "1 oktober", "27 sep6 sep"), zoals
 * agenda's die tonen. Het jaar wordt afgeleid: het jaar waarbij de datum het
 * dichtst bij vandaag ligt (dus in december wordt "3 jan" volgend jaar, en in
 * januari wordt "28 dec" vorig jaar). Bij een bereik ("30 sep11 okt") telt de
 * EERSTE datum, de startdatum. Geeft null als er geen datum in staat.
 *
 * Bewust alleen te gebruiken als de bron als agenda is gemarkeerd: bij
 * gewoon nieuws is een datum zonder jaar te dubbelzinnig om aan te nemen.
 */
function haalDatumZonderJaar(tekst, nu = new Date()) {
  if (!tekst) return null;
  const m = String(tekst).match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*(${MAAND_ALLES})\\.?(?![a-z])`, "i"));
  if (!m) return null;
  const dag = Number(m[1]);
  const sleutel = m[2].toLowerCase();
  const maand = NEDERLANDSE_MAANDEN[sleutel] ?? MAANDEN_KORT[sleutel];
  if (maand === undefined || dag < 1 || dag > 31) return null;

  let beste = null;
  for (const jaar of [nu.getFullYear() - 1, nu.getFullYear(), nu.getFullYear() + 1]) {
    const d = new Date(jaar, maand, dag);
    if (d.getMonth() !== maand) continue; // bestaat niet, zoals 31 februari
    if (!beste || Math.abs(d - nu) < Math.abs(beste - nu)) beste = d;
  }
  return beste ? beste.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Agenda herkennen aan de datums
//
// Een nieuwsbron heeft (vrijwel) nooit berichten uit de toekomst; een agenda wel.
// Gemeten voor zaanscultuurhuis.nl/agenda: slechts 15 van 46 datums liggen in de
// toekomst, omdat de pagina onder de komende evenementen ook de 31 afgelopen
// toont. Daarom twee regels:
//   - de helft of meer van de datums ligt in de toekomst, óf
//   - een gemengde lijst: minstens AGENDA_MENGLIJST_MIN_TOEKOMST datums in de
//     toekomst die samen minstens AGENDA_MENGLIJST_AANDEEL van de datums zijn.
// Altijd met minstens 3 berichten met datum. "Toekomst" is: meer dan 12 uur vooruit.
// ---------------------------------------------------------------------------
const AGENDA_AANDEEL_TOEKOMST = 0.5;
const AGENDA_MENGLIJST_MIN_TOEKOMST = 5;
const AGENDA_MENGLIJST_AANDEEL = 0.2;

function agendaUitDatums(berichten, nu = Date.now()) {
  const metDatum = berichten.filter((b) => tijdVan(b.gepubliceerdOp) !== null);
  const toekomst = metDatum.filter((b) => tijdVan(b.gepubliceerdOp) > nu + 12 * 3600 * 1000);
  const aandeel = metDatum.length ? toekomst.length / metDatum.length : 0;
  let reden = null;
  if (metDatum.length >= 3) {
    if (aandeel >= AGENDA_AANDEEL_TOEKOMST) {
      reden = `${toekomst.length} van de ${metDatum.length} datums liggen in de toekomst (de helft of meer)`;
    } else if (toekomst.length >= AGENDA_MENGLIJST_MIN_TOEKOMST && aandeel >= AGENDA_MENGLIJST_AANDEEL) {
      reden = `${toekomst.length} van de ${metDatum.length} datums liggen in de toekomst (een nieuwsbron heeft die niet; waarschijnlijk staan er ook afgelopen evenementen op de pagina)`;
    }
  }
  return { lijktOpAgenda: reden !== null, metDatum: metDatum.length, toekomst: toekomst.length, reden };
}

/**
 * Leest een datumbereik zoals agenda's dat tonen voor een meerdaags evenement:
 * "30 sep 11 okt", "30 sep11 okt" (zonder spatie), "30 sep - 11 okt",
 * "30 sep t/m 11 okt", "30 september tot 11 oktober", ook met jaartallen
 * ("30 sep 2026 t/m 11 okt 2026"). Geeft { start, eind } (ISO-tekst) of null als
 * er geen bereik in staat. Een enkele datum is geen bereik.
 *
 * Het jaar van de start is het jaar zonder jaartal dat het dichtst bij vandaag
 * ligt (zie haalDatumZonderJaar); het jaar van het einde is dat van de start.
 * Ligt het einde dan vóór de start ("27 sep 6 sep"), dan schuift het naar het
 * jaar erna. Komt het einde daardoor meer dan een jaar na de start, dan wordt
 * het genegeerd (eind: null) en blijft alleen de start over. Een einde gelijk
 * aan de start geeft ook eind: null.
 */
const BEREIK_REGEX = new RegExp(
  `(?<!\\d)(\\d{1,2})\\s*(${MAAND_ALLES})\\.?(?![a-z])(?:\\s*(\\d{4})(?!\\d))?` +
    `\\s*(?:-|–|—|t/m|tm|tot(?:\\s+en\\s+met)?)?\\s*` +
    `(\\d{1,2})\\s*(${MAAND_ALLES})\\.?(?![a-z])(?:\\s*(\\d{4})(?!\\d))?`,
  "i"
);

function haalDatumBereik(tekst, opties = {}) {
  if (!tekst) return null;
  const m = String(tekst).match(BEREIK_REGEX);
  if (!m) return null;
  const nu = opties.nu || new Date();

  const maandVan = (sleutel) => NEDERLANDSE_MAANDEN[sleutel.toLowerCase()] ?? MAANDEN_KORT[sleutel.toLowerCase()];
  const dagStart = Number(m[1]);
  const maandStart = maandVan(m[2]);
  const dagEind = Number(m[4]);
  const maandEind = maandVan(m[5]);
  if (maandStart === undefined || maandEind === undefined) return null;
  if (dagStart < 1 || dagStart > 31 || dagEind < 1 || dagEind > 31) return null;

  // Start: met jaar, of het jaar dat het dichtst bij vandaag ligt.
  let start;
  if (m[3]) {
    start = new Date(Number(m[3]), maandStart, dagStart);
    if (start.getMonth() !== maandStart) return null;
  } else {
    const iso = haalDatumZonderJaar(`${dagStart} ${m[2]}`, nu);
    if (!iso) return null;
    start = new Date(iso);
  }

  // Einde: met jaar, of het jaar van de start; ligt het dan voor de start, dan een jaar later.
  let eind = new Date(m[6] ? Number(m[6]) : start.getFullYear(), maandEind, dagEind);
  if (eind.getMonth() !== maandEind) return { start: start.toISOString(), eind: null }; // bestaat niet, zoals 31 februari
  if (eind < start && !m[6]) eind = new Date(start.getFullYear() + 1, maandEind, dagEind);

  const eenJaarNaStart = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  if (eind < start || eind > eenJaarNaStart || eind.getTime() === start.getTime()) return { start: start.toISOString(), eind: null };
  return { start: start.toISOString(), eind: eind.toISOString() };
}

/**
 * Leest de datum (en bij een bereik ook de einddatum) uit een rij kandidaat-
 * teksten, in volgorde van voorkeur; de eerste die iets oplevert wint. Elke
 * kandidaat is [tekst, modus]: "streng" voor een tekst die zelf de datum is
 * (parseerDatumTekst), "zoek" voor een langere tekst waar een datum in kan
 * staan (haalDatumUitTekst). Bij agenda-bronnen (opties.zonderJaar) wordt in
 * dezelfde tekst eerst naar een bereik gezocht. Geeft { start, eind }, met
 * null waar niets gevonden is.
 */
function leesDatumEnEinde(kandidaten, opties = {}) {
  for (const [tekst, modus] of kandidaten) {
    if (!tekst) continue;
    if (opties.zonderJaar) {
      const bereik = haalDatumBereik(tekst, opties);
      if (bereik) return bereik;
    }
    const datum = modus === "streng" ? parseerDatumTekst(tekst, opties) : haalDatumUitTekst(tekst, opties);
    if (datum) return { start: datum, eind: null };
  }
  return { start: null, eind: null };
}

/**
 * Leest een datum uit tekst of een attribuutwaarde. Vervangt de losse
 * parseerDatum-functies met new Date(tekst), die twee problemen hadden:
 *   - Nederlandse maanden die JavaScript niet kent ("oktober", "maart", "mei")
 *     gaven een ongeldige datum;
 *   - tekst zonder jaar ("30 sep") werd stilletjes als het jaar 2001 gelezen,
 *     waardoor een bericht er als "te oud" uitzag zonder dat iets faalde.
 * new Date() wordt daarom alleen vertrouwd als er een jaartal van 4 cijfers in
 * de tekst staat; dag-maand-jaar met streepjes of slashes wordt als Nederlands
 * (DD-MM-JJJJ) gelezen, niet als Amerikaans.
 */
function parseerDatumTekst(tekst, opties = {}) {
  if (tekst == null) return null;
  const t = String(tekst).trim();
  if (!t) return null;

  const dmj = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (dmj) {
    const d = new Date(Number(dmj[3]), Number(dmj[2]) - 1, Number(dmj[1]), Number(dmj[4] || 0), Number(dmj[5] || 0));
    if (!isNaN(d.getTime()) && d.getMonth() === Number(dmj[2]) - 1) return d.toISOString();
  }

  if (/\d{4}/.test(t)) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return haalDatumUitTekst(t, opties);
}

/**
 * Haalt een URL op met een nette user-agent en duidelijke timeout/foutmelding.
 * Wordt door alle scrapers gebruikt zodat we op één plek retry-/timeoutlogica
 * kunnen aanpassen. Met { stil: true } als derde argument blijven de
 * waarschuwingen per mislukte poging achterwege.
 */
async function haalOpEcht(url, pogingen = 3, opties = {}) {
  let laatsteFout;
  let dispatcher; // blijft gezet zodra een reparatie eenmaal gelukt is voor deze host
  const timeoutMs = opties.timeoutMs || 20_000; // standaard 20 s; de tekststap vraagt een kortere
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const fetchOpties = {
        headers: { "User-Agent": GEBRUIKERSAGENT },
        signal: controller.signal,
      };
      if (dispatcher) fetchOpties.dispatcher = dispatcher;
      const response = await fetch(url, fetchOpties);
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} voor ${url}`);
      }
      return await response.text();
    } catch (fout) {
      laatsteFout = fout;

      if (fout.cause && fout.cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" && !dispatcher) {
        console.warn(`Certificaatketen van ${url} is onvolledig — probeer het ontbrekende tussencertificaat zelf op te halen...`);
        const reparatie = await probeerKetenTeRepareren(url).catch(() => null);
        if (reparatie) {
          console.warn(`Ontbrekend tussencertificaat gevonden via ${reparatie.issuerUrl}, opnieuw proberen.`);
          dispatcher = reparatie.dispatcher;
          continue; // meteen opnieuw fetchen met de gerepareerde keten
        }
      }

      if (fout.cause && fout.cause.message === "redirect count exceeded") {
        console.warn(`${url} stuurt eindeloos door (waarschijnlijk is een sessie-cookie vereist) — probeer met cookie-ondersteuning...`);
        try {
          const cookieOpties = { headers: { "User-Agent": GEBRUIKERSAGENT } };
          if (dispatcher) cookieOpties.dispatcher = dispatcher;
          return await haalOpMetCookies(url, cookieOpties);
        } catch (cookieFout) {
          laatsteFout = cookieFout;
          console.warn(`Cookie-ondersteuning hielp niet: ${cookieFout.message}`);
        }
      }

      // opties.stil: voor proefpogingen (bijvoorbeeld raden of /feed/ bestaat)
      // waar een 404 de normale, verwachte uitkomst is.
      if (!opties.stil) console.warn(`Poging ${poging}/${pogingen} mislukt voor ${url}: ${fout.message}${oorzaakTekst(fout)}`);
      if (poging < pogingen) {
        await nieuweWacht(1000 * poging); // simpele backoff: 1s, 2s, 3s...
      }
    }
  }
  throw laatsteFout;
}

/**
 * Responscache voor één ontdekkingsrun (bron-ontdekking.js). Bij het uitzoeken
 * van een bron wordt dezelfde pagina door veel tests gebruikt: de ontdekking
 * zelf, de JSON-LD-test, en elke Gemini-poging (soms twee keer). Zonder cache
 * waren dat tientallen verzoeken op één url binnen een minuut; sommige sites
 * (of hun firewall) laten de verbinding dan verlopen, waarna een goed recept
 * ten onrechte als fout werd beoordeeld. Met de cache gaat elke url één keer
 * over het netwerk, en testen alle methodes op precies dezelfde HTML.
 *
 * Alleen aan tijdens een ontdekkingsrun. De dagelijkse run gebruikt hem niet,
 * want daar wil je elke nacht verse pagina's. Met RESPONSCACHE=uit staat hij
 * ook tijdens ontdekking uit (alleen voor het zoeken naar fouten).
 */
let responsCache = null;

function startResponsCache() {
  responsCache = process.env.RESPONSCACHE === "uit" ? null : new Map();
}

function stopResponsCache() {
  responsCache = null;
}

async function haalOp(url, pogingen = 3, opties = {}) {
  if (responsCache && responsCache.has(url)) return responsCache.get(url);
  const tekst = await haalOpEcht(url, pogingen, opties);
  if (responsCache) responsCache.set(url, tekst);
  return tekst;
}

/**
 * Is dit een fout van het netwerk of de server (time-out, verbinding verbroken,
 * 429, 5xx, 403) in plaats van een fout in wat we ermee doen? Dan zegt een
 * mislukte test niets over de kwaliteit van een recept, en moeten we dat ook
 * niet als zodanig behandelen.
 */
function isNetwerkFout(fout) {
  if (!fout) return false;
  const codes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"];
  const cause = fout.cause;
  const gevonden = [fout.code, cause && cause.code, ...((cause && cause.errors) || []).map((e) => e && e.code)];
  if (gevonden.some((c) => codes.includes(c))) return true;
  return /fetch failed|aborted|timed out|timeout|HTTP (403|429|5\d\d)\b/i.test(String(fout.message));
}

function nieuweWacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parset RSS-XML-tekst naar een lijst van genormaliseerde berichtobjecten.
 * Elk <item> wordt hier al een los, duidelijk gescheiden bericht (zie ook
 * scrapers/rss.js) — dit is dus het punt waarop "elk nieuwsbericht duidelijk
 * gescheiden" in de RSS wordt gegarandeerd.
 */
async function parseerRssTekst(tekst, bron) {
  const feed = await rssParser.parseString(tekst);
  return (feed.items || []).map((item) => ({
    bronId: bron.id,
    bronNaam: bron.naam,
    categorie: bron.categorie,
    titel: (item.title || "").trim(),
    url: item.link || "",
    samenvatting: schoonmakenSamenvatting(item.contentSnippet || item.content || ""),
    gepubliceerdOp: item.isoDate || item.pubDate || null,
    opgehaaldOp: new Date().toISOString(),
  }));
}

function schoonmakenSamenvatting(tekst) {
  return tekst.replace(/\s+/g, " ").trim().slice(0, 600);
}

// ---------------------------------------------------------------------------
// Paginering
//
// Veel lijstpagina's tonen maar een deel van de berichten (bijvoorbeeld
// waarheen.deorkaan.nl/agenda/ met 39 pagina's op /agenda/page/2/, /page/3/,
// ...). volgPaginas() leest pagina na pagina en stopt zodra verder lezen geen
// bruikbare berichten meer kan opleveren:
//   - agenda's: zodra het laatste bericht met datum van een pagina voorbij
//     vandaag ligt (bij een oplopende lijst) of al voorbij is (bij een
//     aflopende lijst);
//   - nieuws: zodra het laatste bericht met datum van een pagina ouder is dan
//     MAX_LEEFTIJD_DAGEN (bij een lijst met de nieuwste bovenaan);
//   - of als er geen volgende pagina is, de pagina niets nieuws bevat, geen
//     enkel bericht een datum heeft, of de harde bovengrens MAX_PAGINAS bereikt is.
// Er wordt hier NIET gefilterd: de centrale filter in index.js blijft bepalen
// wat binnen het venster valt. Dit bepaalt alleen hoeveel pagina's we ophalen.
// ---------------------------------------------------------------------------

const MAX_PAGINAS = Number(process.env.MAX_PAGINAS || 10); // harde bovengrens, per bron per run
const PAGINA_PAUZE_MS = Number(process.env.PAGINA_PAUZE_MS || 500); // pauze tussen twee pagina's van dezelfde bron

function tijdVan(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

/** Oplopend (oudste/vroegste eerst) of aflopend? Meerderheid van de stappen tussen opeenvolgende datums; bij gelijkspel `standaard`. */
function lijstRichting(berichten, standaard) {
  const tijden = berichten.map((b) => tijdVan(b.gepubliceerdOp)).filter((t) => t !== null);
  let op = 0;
  let neer = 0;
  for (let i = 1; i < tijden.length; i++) {
    if (tijden[i] > tijden[i - 1]) op++;
    else if (tijden[i] < tijden[i - 1]) neer++;
  }
  return op > neer ? "oplopend" : neer > op ? "aflopend" : standaard;
}

/**
 * Is deze pagina de laatste die de moeite waard is? Geeft een reden (tekst) als
 * we moeten stoppen, anders null. Kijkt naar het LAATSTE bericht met datum in
 * paginavolgorde: bij een gesorteerde lijst is dat gelijk aan "het eerste
 * bericht buiten het venster", maar één afwijkend bericht bovenaan (een
 * vastgepinned bericht) zet de teller niet op slot.
 */
function paginaVoorbij(bron, paginaBerichten, nu = Date.now()) {
  const metDatum = paginaBerichten.filter((b) => tijdVan(b.gepubliceerdOp) !== null);
  if (metDatum.length === 0) return "geen enkel bericht op deze pagina heeft een datum (zulke berichten worden toch geweerd)";
  const dag = 24 * 60 * 60 * 1000;
  const laatste = metDatum[metDatum.length - 1];
  const start = tijdVan(laatste.gepubliceerdOp);
  const eind = tijdVan(laatste.eindDatum) ?? start;
  const datumTekst = String(laatste.gepubliceerdOp).slice(0, 10);

  if (bron.soort === "agenda") {
    const richting = lijstRichting(metDatum, "oplopend");
    const nuDatum = new Date();
    const beginVandaag = new Date(nuDatum.getFullYear(), nuDatum.getMonth(), nuDatum.getDate()).getTime();
    const eindVandaag = beginVandaag + dag;
    if (richting === "oplopend" && start >= eindVandaag) {
      return `agenda is voorbij het venster (laatste evenement op deze pagina: ${datumTekst}, na vandaag)`;
    }
    if (richting === "aflopend" && eind < beginVandaag) {
      return `agenda is voorbij het venster (laatste evenement op deze pagina: ${datumTekst}, al voorbij)`;
    }
    return null;
  }
  if (lijstRichting(metDatum, "aflopend") === "aflopend" && start < nu - MAX_LEEFTIJD_DAGEN * dag) {
    return `berichten zijn ouder dan ${MAX_LEEFTIJD_DAGEN} dagen (laatste op deze pagina: ${datumTekst})`;
  }
  return null;
}

/** Zoekt de url van de volgende pagina: eerst de configuratie (bron.paginering), anders wat de pagina zelf aanwijst. */
function vindVolgendePagina($, paginaUrl, huidigNummer, paginering) {
  const absoluut = (href) => {
    try {
      const u = new URL(href, paginaUrl);
      return ["http:", "https:"].includes(u.protocol) ? u.toString() : null;
    } catch {
      return null;
    }
  };

  if (paginering && paginering.soort === "patroon" && paginering.patroon) {
    return absoluut(paginering.patroon.replace("{n}", String(huidigNummer + 1)));
  }
  if (paginering && paginering.soort === "volgende-link" && paginering.selector) {
    const el = $(paginering.selector).first();
    const href = el.is("a[href]") ? el.attr("href") : el.find("a[href]").first().attr("href");
    return href ? absoluut(href) : null;
  }

  // Geen configuratie: alleen aanwijzingen die de pagina zelf geeft.
  const relNext = $('link[rel~="next"], a[rel~="next"]').first().attr("href");
  if (relNext) return absoluut(relNext);

  const volgende = huidigNummer + 1;
  let gevonden = null;
  $("a[href]").each((_, a) => {
    if (gevonden) return;
    const href = $(a).attr("href");
    const abs = absoluut(href);
    if (!abs) return;
    const u = new URL(abs);
    const padMatch = u.pathname.match(/\/(?:page|pagina|p)\/(\d+)\/?$/i);
    const queryNummer = ["page", "pagina", "paged", "p"].map((k) => u.searchParams.get(k)).find((v) => v && /^\d+$/.test(v));
    if ((padMatch && Number(padMatch[1]) === volgende) || (queryNummer && Number(queryNummer) === volgende)) gevonden = abs;
  });
  return gevonden;
}

/**
 * Leest de lijstpagina van een bron en alle vervolgpagina's.
 *
 *   bron          de bron-config (url, soort, paginering, id)
 *   leesPagina    ($, paginaUrl, paginaNummer) => lijst berichten van die ene pagina (mag async)
 *   opties        { eersteHtml (al opgehaalde eerste pagina), log, maxPaginas, pauzeMs, haal }
 *
 * Geeft { berichten, paginas, reden } terug: alle berichten (zonder dubbele
 * url's), het aantal gelezen pagina's en waarom er gestopt is. De eerste
 * pagina geeft zijn fouten door aan de aanroeper (zoals voorheen). Een fout op
 * een vervolgpagina stopt alleen het doorlezen: wat er al is blijft staan, en
 * de fout komt in de log (404 geldt als "geen pagina's meer").
 */
async function volgPaginas(bron, leesPagina, opties = {}) {
  const { log = console, maxPaginas = MAX_PAGINAS, pauzeMs = PAGINA_PAUZE_MS, haal = haalOp } = opties;
  const alle = [];
  const gezienBerichtUrls = new Set();
  const bezocht = new Set();
  let paginaUrl = bron.url;
  let html = opties.eersteHtml !== undefined ? opties.eersteHtml : await haal(bron.url);
  let reden = null;
  let n = 1;

  for (; ; n++) {
    bezocht.add(paginaUrl);
    const $ = cheerio.load(html);
    let pagina;
    try {
      pagina = (await leesPagina($, paginaUrl, n)) || [];
    } catch (fout) {
      if (n === 1) throw fout; // pagina 1 geeft zijn fouten door, zoals voorheen
      reden = `pagina ${n} lezen mislukte: ${fout.message}`;
      log.warn(`[${bron.id}] ${reden}. Doorgaan met de ${alle.length} berichten van de eerste ${n - 1} pagina('s).`);
      n--;
      break;
    }
    const nieuw = pagina.filter((b) => b.url && !gezienBerichtUrls.has(b.url));
    nieuw.forEach((b) => gezienBerichtUrls.add(b.url));
    alle.push(...nieuw);

    const metDatum = pagina.filter((b) => tijdVan(b.gepubliceerdOp) !== null);
    const datumBereik = metDatum.length ? `, datums ${String(metDatum[0].gepubliceerdOp).slice(0, 10)} t/m ${String(metDatum[metDatum.length - 1].gepubliceerdOp).slice(0, 10)}` : "";
    log.log(`[${bron.id}] pagina ${n}: ${pagina.length} bericht(en), ${nieuw.length} nieuw${datumBereik}.`);

    if (pagina.length === 0) {
      reden = n === 1 ? "pagina 1 bevat geen berichten" : `pagina ${n} bevat geen berichten`;
      break;
    }
    if (nieuw.length === 0) {
      reden = `pagina ${n} bevat niets nieuws (waarschijnlijk dezelfde pagina als de vorige)`;
      break;
    }
    const voorbij = paginaVoorbij(bron, pagina);
    if (voorbij) {
      reden = voorbij;
      break;
    }
    if (n >= maxPaginas) {
      reden = `harde bovengrens van ${maxPaginas} pagina's bereikt (instelbaar met MAX_PAGINAS) — er zijn mogelijk nog meer berichten`;
      log.warn(`[${bron.id}] ${reden}.`);
      break;
    }

    const volgende = vindVolgendePagina($, paginaUrl, n, bron.paginering);
    if (!volgende) {
      reden = "geen volgende pagina";
      break;
    }
    if (bezocht.has(volgende)) {
      reden = `volgende pagina (${volgende}) is al gelezen`;
      break;
    }

    await nieuweWacht(pauzeMs);
    try {
      html = await haal(volgende, 2, { stil: true });
    } catch (fout) {
      if (/HTTP 404/.test(fout.message)) {
        reden = `pagina ${n + 1} bestaat niet (404): einde van de lijst`;
      } else {
        reden = `pagina ${n + 1} ophalen mislukte: ${fout.message}${oorzaakTekst(fout)}`;
        log.warn(`[${bron.id}] ${reden}. Doorgaan met de ${alle.length} berichten van de eerste ${n} pagina('s).`);
      }
      break;
    }
    paginaUrl = volgende;
  }

  log.log(`[${bron.id}] ${n} pagina('s) gelezen, ${alle.length} bericht(en); gestopt omdat: ${reden}.`);
  return { berichten: alle, paginas: n, reden };
}

// ---------------------------------------------------------------------------
// Tekst per bericht ophalen
//
// Een lijstpagina toont meestal alleen een titel en soms een stukje tekst. Om
// te kunnen beoordelen wat een bericht voor mensen betekent, heeft Gemini de
// tekst van het bericht zelf nodig. Deze functies halen die op van de
// bericht-URL. Gedeeld door index.js (dagelijkse run) en bron-poort.js (het
// bewijs bij het toevoegen van een bron), zodat beide exact hetzelfde doen.
// ---------------------------------------------------------------------------

const ARTIKEL_MAX_TEKENS = 3000; // zo lang mag de tekst per bericht maximaal worden
const LIJSTTEKST_GENOEG_TEKENS = 600; // heeft de lijst al zoveel tekst, dan halen we niets op
const MIN_BRUIKBARE_TEKST_TEKENS = 100; // korter dan dit telt niet als "met tekst"
const ARTIKEL_TIMEOUT_MS = 15_000; // per poging
const ARTIKEL_TOTAAL_TIMEOUT_MS = 40_000; // alle pogingen samen, per bericht
const ARTIKEL_PARALLEL = Number(process.env.ARTIKELTEKST_PARALLEL || 4); // hoeveel verschillende sites tegelijk
const ARTIKEL_PAUZE_MS = Number(process.env.ARTIKELTEKST_PAUZE_MS || 400); // pauze tussen twee verzoeken aan dezelfde site
const ARTIKEL_MAX_SECONDEN = Number(process.env.ARTIKELTEKST_MAX_SECONDEN || 900); // daarna stopt de stap, de rest houdt de lijsttekst
const MAX_NETWERKFOUTEN_ACHTEREEN = 3; // daarna slaan we de rest van die site over

// Alles wat nooit bij de inhoud van een bericht hoort.
const ARTIKEL_WEG =
  'script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  ".breadcrumb, .breadcrumbs, .share, .social, .cookie, .cookies, #cookie, .related, .comments";

// Waar de inhoud meestal staat, van specifiek naar breed. De laatste twee
// selectors zijn specifiek voor de Mozard-suite (loket.zaanstad.nl): daar
// staat de inhoud in een div met id me_CBCzqv en class aandachttekst__tekst.
// Zonder die toevoeging blijft de samenvatting van hoorzittingen leeg.
const ARTIKEL_INHOUD_SELECTORS = [
  "article", "main", '[role="main"]', ".entry-content", ".post-content", ".article-content",
  ".article-body", ".node__content", ".content-main", "#content", ".content",
  "#me_CBCzqv", ".aandachtstekst__tekst",
];

function maakSchoneTekst(tekst) {
  return String(tekst || "").replace(/\s+/g, " ").trim();
}

/** Kapt af op een woordgrens, tot ongeveer `max` tekens. */
function kortAf(tekst, max) {
  if (tekst.length <= max) return tekst;
  const stuk = tekst.slice(0, max);
  const laatsteSpatie = stuk.lastIndexOf(" ");
  return `${(laatsteSpatie > max - 150 ? stuk.slice(0, laatsteSpatie) : stuk).trim()}…`;
}

/**
 * Haalt de tekst van een bericht uit de HTML van de berichtpagina. Puur: geen
 * netwerk. Geeft { tekst, methode } of null als er geen bruikbare tekst staat.
 *   1. De inhoud-blokken (article, main, ...), nadat navigatie, footer,
 *      scripts en dergelijke zijn weggehaald.
 *   2. Anders de meta description van de pagina (og:description of description).
 */
function haalTekstUitHtml(html) {
  if (!html || String(html).startsWith("%PDF-")) return null;
  const $ = cheerio.load(html);

  const metaTeksten = [$('meta[property="og:description"]').attr("content"), $('meta[name="description"]').attr("content")]
    .map(maakSchoneTekst)
    .sort((a, b) => b.length - a.length);

  $(ARTIKEL_WEG).remove();
  // Zonder dit plakt cheerio de tekst van losse blokken aan elkaar ("1 oktober 2026Evenement 2").
  $("p, li, h1, h2, h3, h4, h5, h6, br, div, tr, section").after("\n");

  for (const selector of ARTIKEL_INHOUD_SELECTORS) {
    let langste = "";
    $(selector).each((_, el) => {
      const tekst = maakSchoneTekst($(el).text());
      if (tekst.length > langste.length) langste = tekst;
    });
    if (langste.length >= MIN_BRUIKBARE_TEKST_TEKENS) {
      return { tekst: kortAf(langste, ARTIKEL_MAX_TEKENS), methode: "artikel" };
    }
  }

  if (metaTeksten[0] && metaTeksten[0].length >= MIN_BRUIKBARE_TEKST_TEKENS) {
    return { tekst: kortAf(metaTeksten[0], ARTIKEL_MAX_TEKENS), methode: "meta-beschrijving" };
  }
  return null;
}

/** Wacht op een belofte, maar hooguit `ms`. De belofte zelf kan niet worden afgebroken, dus een late fout wordt hier opgevangen. */
function metTijdslimiet(belofte, ms, melding) {
  belofte.catch(() => {}); // anders crasht Node bij een fout die na de time-out nog komt
  let timer;
  const limiet = new Promise((_, afwijzen) => {
    timer = setTimeout(() => afwijzen(new Error(melding)), ms);
  });
  return Promise.race([belofte, limiet]).finally(() => clearTimeout(timer));
}

/**
 * Haalt de pagina van één bericht op en geeft { tekst, methode } of null als
 * de pagina geen bruikbare tekst bevat (bijvoorbeeld een pdf of een pagina
 * die alleen met JavaScript gevuld wordt). Gooit een fout als de pagina niet
 * op te halen was; de aanroeper beslist wat dan gebeurt.
 *
 * Extra logging: als de pagina wel is opgehaald maar geen bruikbare tekst
 * bevat, wordt dat gelogd met de URL en de HTML-lengte. Dat helpt om te
 * onderscheiden of het een fetch-probleem is (lege pagina) of een
 * selector-probleem (de tekst staat er wel, maar niet op een plek die we
 * herkennen). Zonder deze logging is een lege samenvatting niet te debuggen.
 */
async function haalArtikelTekst(url) {
  if (!url || /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(\?|#|$)/i.test(url)) return null;
  try {
    const html = await metTijdslimiet(
      haalOp(url, 2, { stil: true, timeoutMs: ARTIKEL_TIMEOUT_MS }),
      ARTIKEL_TOTAAL_TIMEOUT_MS,
      `timeout na ${ARTIKEL_TOTAAL_TIMEOUT_MS / 1000}s bij het ophalen van ${url}`
    );
    const resultaat = haalTekstUitHtml(html);
    if (!resultaat) {
      console.log(`[tekst] Geen bruikbare tekst op ${url} (HTML: ${html.length} tekens).`);
    }
    return resultaat;
  } catch (fout) {
    console.log(`[tekst] Kon ${url} niet ophalen: ${fout.message}${oorzaakTekst(fout)}`);
    throw fout;
  }
}

function hostVan(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "onbekend";
  }
}

/**
 * Vult het veld samenvatting van berichten aan met de tekst van de
 * berichtpagina, voor berichten waarvan de lijsttekst korter is dan
 * `lijsttekstGenoeg` (standaard ca. 600 tekens). De berichten worden ter
 * plekke aangepast. Lukt het ophalen niet, dan blijft de lijsttekst staan: het
 * bericht gaat gewoon door. Een fout wordt altijd geteld en gelogd.
 *
 * Netjes voor de sites: per site één verzoek tegelijk met een pauze ertussen,
 * en hooguit een paar verschillende sites tegelijk. Geeft een site drie keer
 * achter elkaar een netwerkfout (time-out, 403, 429, 5xx), dan slaan we de rest
 * van die site over. Na `maxSeconden` stopt de hele stap.
 *
 * opties: { nietOphalen(bericht) => bool (bijvoorbeeld voor iBabs, dat zijn
 *           eigen documenttekst meebrengt), haalTekst (voor tests), log }
 * Geeft { perBron: { [bronId]: { totaal, metTekst, opgehaald, geenTekst, fouten, overgeslagen } }, tijdOp }
 */
async function vulBerichtenAanMetTekst(berichten, opties = {}) {
  const {
    nietOphalen = () => false,
    haalTekst = haalArtikelTekst,
    log = console,
    lijsttekstGenoeg = LIJSTTEKST_GENOEG_TEKENS,
    parallel = ARTIKEL_PARALLEL,
    pauzeMs = ARTIKEL_PAUZE_MS,
    maxSeconden = ARTIKEL_MAX_SECONDEN,
  } = opties;

  const perBron = {};
  const stat = (id) => (perBron[id] ||= { totaal: 0, metTekst: 0, opgehaald: 0, geenTekst: 0, fouten: 0, overgeslagen: 0 });

  const perHost = new Map();
  for (const b of berichten) {
    if ((b.samenvatting || "").length >= lijsttekstGenoeg || nietOphalen(b)) continue;
    const host = hostVan(b.url);
    if (!perHost.has(host)) perHost.set(host, []);
    perHost.get(host).push(b);
  }

  const einde = Date.now() + maxSeconden * 1000;
  let tijdOp = false;

  async function verwerkHost(host, lijst) {
    let netwerkFoutenAchtereen = 0;
    let hostGestopt = false;
    for (let i = 0; i < lijst.length; i++) {
      const b = lijst[i];
      const s = stat(b.bronId);
      if (hostGestopt) {
        s.overgeslagen++;
        continue;
      }
      if (Date.now() > einde) {
        tijdOp = true;
        s.overgeslagen++;
        continue;
      }
      try {
        const uit = await haalTekst(b.url);
        netwerkFoutenAchtereen = 0;
        if (uit && uit.tekst && uit.tekst.length > (b.samenvatting || "").length) {
          b.samenvatting = uit.tekst;
          s.opgehaald++;
        } else {
          s.geenTekst++;
        }
      } catch (fout) {
        s.fouten++;
        if (s.fouten <= 3) log.warn(`[${b.bronId}] Tekst ophalen mislukt voor ${b.url}: ${fout.message}${oorzaakTekst(fout)} — het bericht gaat door met de lijsttekst.`);
        netwerkFoutenAchtereen = isNetwerkFout(fout) ? netwerkFoutenAchtereen + 1 : 0;
        if (netwerkFoutenAchtereen >= MAX_NETWERKFOUTEN_ACHTEREEN) {
          hostGestopt = true;
          log.warn(`[${b.bronId}] ${host} gaf ${MAX_NETWERKFOUTEN_ACHTEREEN} keer achter elkaar een netwerkfout; de overige berichten van deze site houden hun lijsttekst.`);
        }
      }
      if (i < lijst.length - 1 && !hostGestopt) await nieuweWacht(pauzeMs);
    }
  }

  const wachtrij = [...perHost.entries()];
  const werkers = Array.from({ length: Math.max(1, Math.min(parallel, wachtrij.length)) }, async () => {
    while (wachtrij.length > 0) {
      const [host, lijst] = wachtrij.shift();
      await verwerkHost(host, lijst);
    }
  });
  await Promise.all(werkers);
  if (tijdOp) log.warn(`De tekststap stopte na ${maxSeconden}s; de overige berichten houden hun lijsttekst.`);

  for (const b of berichten) {
    const s = stat(b.bronId);
    s.totaal++;
    if ((b.samenvatting || "").length >= MIN_BRUIKBARE_TEKST_TEKENS) s.metTekst++;
  }
  return { perBron, tijdOp };
}

/** "12 van 14 met tekst" — de korte vorm voor logs, rapporten en Actions-samenvattingen. */
function tekstDekkingTekst(s) {
  return `${s.metTekst} van ${s.totaal} met tekst`;
}

/** De uitgebreide vorm: waar de tekst vandaan kwam en wat er misging. */
function tekstStatistiekRegel(s) {
  const delen = [`${s.opgehaald} van de berichtpagina`, `${Math.max(0, s.metTekst - s.opgehaald)} uit de lijst`];
  if (s.geenTekst) delen.push(`${s.geenTekst} pagina('s) zonder bruikbare tekst`);
  if (s.fouten) delen.push(`${s.fouten} mislukt`);
  if (s.overgeslagen) delen.push(`${s.overgeslagen} overgeslagen`);
  return `${tekstDekkingTekst(s)} (${delen.join(", ")})`;
}

module.exports = {
  haalOp,
  startResponsCache,
  stopResponsCache,
  isNetwerkFout,
  parseerRssTekst,
  oorzaakTekst,
  probeerKetenTeRepareren,
  haalOpMetCookies,
  haalDatumUitTekst,
  haalDatumZonderJaar,
  haalDatumBereik,
  leesDatumEnEinde,
  agendaUitDatums,
  parseerDatumTekst,
  GEBRUIKERSAGENT,
  MAX_LEEFTIJD_DAGEN,
  AGENDA_MAX_VERLEDEN_DAGEN,
  AGENDA_MAX_VOORUIT_DAGEN,
  binnenLeeftijdsgrens,
  binnenAgendaVenster,
  binnenVenster,
  leeftijdInDagen,
  volgPaginas,
  paginaVoorbij,
  vindVolgendePagina,
  MAX_PAGINAS,
  haalTekstUitHtml,
  haalArtikelTekst,
  vulBerichtenAanMetTekst,
  tekstDekkingTekst,
  tekstStatistiekRegel,
  ARTIKEL_MAX_TEKENS,
  LIJSTTEKST_GENOEG_TEKENS,
  MIN_BRUIKBARE_TEKST_TEKENS,
};
