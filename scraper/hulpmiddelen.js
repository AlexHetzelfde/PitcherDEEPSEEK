// hulpmiddelen.js
// Gedeelde functies die door meerdere scrapers gebruikt worden.

const cheerio = require("cheerio");
const Parser = require("rss-parser");
// rss-parser parset standaard alleen <enclosure> voor afbeeldingen. Veel
// Nederlandse feeds gebruiken echter de Media RSS-namespace (media:content,
// media:thumbnail) en content:encoded. Met customFields levert de parser die
// ook mee, zodat we een foto kunnen meenemen zonder de berichtpagina op te
// hoeven halen.
const rssParser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["content:encoded", "contentEncoded"],
    ],
  },
});
const tls = require("tls");
const crypto = require("crypto");
const { Agent } = require("undici");

const GEBRUIKERSAGENT =
  "NieuwsaggregatorZaanstreekBot/1.0 (+journalistiek studentenproject; contact via github repo)";

// Aantal kalenderdagen terug dat een nieuwsbericht nog mag worden meegenomen.
//   0 = alleen vandaag
//   1 = gisteren + vandaag  ← dit is de gewenste stand
//   2 = eergisteren + gisteren + vandaag
// De grens wordt berekend vanaf middernacht van vandaag, NIET als "X keer 24
// uur geleden". Dat verschil is belangrijk: bij een run om 01:00 's nachts
// zou een artikel van gisterenochtend anders net buiten het venster vallen,
// terwijl we het juist wel willen meenemen.
const MAX_LEEFTIJD_DAGEN = 1;

/**
 * Het begintijdstip van het nieuwsvenster: middernacht van (MAX_LEEFTIJD_DAGEN
 * + 1) kalenderdagen geleden, in lokale tijd. Bij MAX_LEEFTIJD_DAGEN = 1 is
 * dat middernacht van gisteren. Alles vanaf dat moment hoort bij "nieuws van
 * gisteren en vandaag".
 */
function beginNieuwsVenster(nu = new Date()) {
  const beginVandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate()).getTime();
  return beginVandaag - MAX_LEEFTIJD_DAGEN * 24 * 60 * 60 * 1000;
}

/**
 * True als een datum binnen het nieuwsvenster valt (vanaf middernacht
 * gisteren, tot nu). Een bericht ZONDER betrouwbaar herkende datum telt hier
 * bewust als "te oud": een bron waarvan structureel geen datum wordt herkend,
 * levert 0 berichten op — zichtbaar fout, in plaats van onzichtbaar fout.
 */
function binnenLeeftijdsgrens(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return false;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return false;
  return datum.getTime() >= beginNieuwsVenster();
}

// Agenda-bronnen (bron.soort === "agenda") tonen vooral evenementen die nog moeten
// komen. Daar geldt een eigen venster: alleen evenementen die VANDAAG beginnen.
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
 * gewone leeftijdsgrens voor alle andere.
 */
function binnenVenster(gepubliceerdOpIso, bron, eindDatumIso) {
  return bron && bron.soort === "agenda" ? binnenAgendaVenster(gepubliceerdOpIso, eindDatumIso) : binnenLeeftijdsgrens(gepubliceerdOpIso);
}

/**
 * Leeftijd van een bericht in dagen (kan een fractie zijn), of null als er
 * geen betrouwbare datum is.
 */
function leeftijdInDagen(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return null;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return null;
  return (Date.now() - datum.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Node's fetch (undici) gooit bij netwerkproblemen bijna altijd alleen de
 * generieke `TypeError: fetch failed` als `.message`; de échte reden zit dan
 * in `.cause`, die Node zelf NIET mee-print. Deze helper haalt die oorzaak
 * eruit zodat we hem overal kunnen loggen.
 */
function oorzaakTekst(fout) {
  const oorzaak = fout && fout.cause;
  if (!oorzaak) return "";
  const code = oorzaak.code ? ` [${oorzaak.code}]` : "";
  const tekst = oorzaak.message || String(oorzaak);
  return ` — oorzaak: ${tekst}${code}`;
}

/**
 * Sommige servers sturen bij het TLS-handshaken niet hun volledige
 * certificaatketen mee (loket.zaanstad.nl bijvoorbeeld). Een browser haalt het
 * ontbrekende tussencertificaat stilzwijgend op via de "CA Issuers"-link in
 * het certificaat zelf (AIA-fetching); Node doet dat niet. Deze functie doet
 * hetzelfde: lees het certificaat, volg de CA-link, en geef een fetch-optie
 * terug die het extra certificaat aan de vertrouwde roots toevoegt.
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
    if (!match) break;
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
        const x = new crypto.X509Certificate(issuerBuffer);
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
 * Sommige sites sturen bij het eerste bezoek een sessie-cookie mee en blijven
 * doorverwijzen totdat die cookie wordt teruggestuurd. Een browser doet dat
 * automatisch; Node's fetch() heeft geen cookie-jar. Deze functie volgt
 * redirects zelf, houdt cookies bij tussen de hops in, en geeft de
 * uiteindelijke pagina-inhoud terug.
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

const NEDERLANDSE_MAANDEN = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

const MAANDEN_LANG = "januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december";
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
    if (d.getMonth() !== maand) continue;
    if (!beste || Math.abs(d - nu) < Math.abs(beste - nu)) beste = d;
  }
  return beste ? beste.toISOString() : null;
}

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

  let start;
  if (m[3]) {
    start = new Date(Number(m[3]), maandStart, dagStart);
    if (start.getMonth() !== maandStart) return null;
  } else {
    const iso = haalDatumZonderJaar(`${dagStart} ${m[2]}`, nu);
    if (!iso) return null;
    start = new Date(iso);
  }

  let eind = new Date(m[6] ? Number(m[6]) : start.getFullYear(), maandEind, dagEind);
  if (eind.getMonth() !== maandEind) return { start: start.toISOString(), eind: null };
  if (eind < start && !m[6]) eind = new Date(start.getFullYear() + 1, maandEind, dagEind);

  const eenJaarNaStart = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  if (eind < start || eind > eenJaarNaStart || eind.getTime() === start.getTime()) return { start: start.toISOString(), eind: null };
  return { start: start.toISOString(), eind: eind.toISOString() };
}

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

async function haalOpEcht(url, pogingen = 3, opties = {}) {
  let laatsteFout;
  let dispatcher;
  const timeoutMs = opties.timeoutMs || 20_000;
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
          continue;
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

      if (!opties.stil) console.warn(`Poging ${poging}/${pogingen} mislukt voor ${url}: ${fout.message}${oorzaakTekst(fout)}`);
      if (poging < pogingen) {
        await nieuweWacht(1000 * poging);
      }
    }
  }
  throw laatsteFout;
}

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

// ---------------------------------------------------------------------------
// Foto's
// ---------------------------------------------------------------------------

/** Kleine helper: haalt een url uit een media:content-achtige structuur. */
function urlUitMediaKnoop(knoop) {
  if (!knoop) return null;
  if (typeof knoop === "string") return knoop;
  // rss-parser levert { $: { url }, ... } bij keepArray, of direct .url bij
  // enkelvoudige waarden, of een array van knopen.
  if (Array.isArray(knoop)) {
    for (const k of knoop) {
      const u = urlUitMediaKnoop(k);
      if (u) return u;
    }
    return null;
  }
  if (knoop.$ && typeof knoop.$.url === "string") return knoop.$.url;
  if (typeof knoop.url === "string") return knoop.url;
  return null;
}

/**
 * Foto uit één RSS-item halen, in volgorde van betrouwbaarheid:
 *   1. <enclosure url="...">  (standaard RSS)
 *   2. <media:content url="...">  (Media RSS)
 *   3. <media:thumbnail url="...">
 *   4. <img src="..."> in content:encoded of content
 * Geeft null als niets gevonden is.
 */
function haalFotoUitRssItem(item) {
  if (!item) return null;
  if (item.enclosure && typeof item.enclosure.url === "string") return item.enclosure.url;
  const mediaContent = urlUitMediaKnoop(item.mediaContent);
  if (mediaContent) return mediaContent;
  const mediaThumbnail = urlUitMediaKnoop(item.mediaThumbnail);
  if (mediaThumbnail) return mediaThumbnail;
  const content = item.contentEncoded || item.content || "";
  const imgMatch = String(content).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

/**
 * Foto uit een al geladen cheerio-document halen. Eerst de Open Graph- en
 * Twitter-meta-tags (die zijn bedoeld voor dit doel), dan het klassieke
 * rel="image_src". Geeft null als er niets staat.
 */
function haalFotoUitHtml($) {
  const og = $('meta[property="og:image"]').attr("content") || $('meta[property="og:image:secure_url"]').attr("content");
  if (og) return og.trim();
  const tw = $('meta[name="twitter:image"]').attr("content") || $('meta[name="twitter:image:src"]').attr("content");
  if (tw) return tw.trim();
  const link = $('link[rel="image_src"]').attr("href");
  if (link) return link.trim();
  return null;
}

/** Maakt een url absoluut tegen een basis; geeft de url onveranderd terug als er geen basis is of de url ongeldig is. */
function maakAbsoluut(url, basis) {
  if (!url || typeof url !== "string") return null;
  const schoon = url.trim();
  if (!schoon) return null;
  if (!basis) return schoon;
  try {
    return new URL(schoon, basis).toString();
  } catch {
    return schoon;
  }
}

/**
 * Foto uit één lijst-item halen (cheerio-element). Volgorde van proberen:
 *   1. fotoSelector (als opgegeven): het element met de afbeelding.
 *   2. Anders: de eerste <img> binnen het item.
 * Voor het attribuut: fotoAttribuut als opgegeven, anders de standaard
 * volgorde src, data-src, data-lazy-src, data-original, en als laatste de
 * eerste url uit srcset. Data-urls (base64) worden overgeslagen.
 * De url wordt absoluut gemaakt tegen baseUrl (meestal de pagina-url).
 * Geeft null als er geen bruikbare foto te vinden is.
 */
function haalFotoUitItem($, el, fotoSelector, fotoAttribuut, baseUrl) {
  if (!el) return null;

  let imgEl;
  if (fotoSelector && typeof fotoSelector === "string" && fotoSelector.trim()) {
    const selector = fotoSelector.trim();
    imgEl = $(el).is(selector) ? $(el) : $(el).find(selector).first();
  } else {
    imgEl = $(el).find("img").first();
  }
  if (!imgEl || imgEl.length === 0) return null;

  const attributen =
    fotoAttribuut && typeof fotoAttribuut === "string" && fotoAttribuut.trim()
      ? [fotoAttribuut.trim()]
      : ["src", "data-src", "data-lazy-src", "data-original"];

  const bruikbaar = (waarde) => typeof waarde === "string" && waarde.trim() && !/^data:/i.test(waarde.trim());

  for (const naam of attributen) {
    const waarde = imgEl.attr(naam);
    if (bruikbaar(waarde)) return maakAbsoluut(waarde, baseUrl);
  }

  // srcset als laatste redmiddel: de eerste url vóór de eerste komma/spatie.
  const srcset = imgEl.attr("srcset");
  if (typeof srcset === "string" && srcset.trim()) {
    const eerste = srcset.split(",")[0].trim().split(/\s+/)[0];
    if (bruikbaar(eerste)) return maakAbsoluut(eerste, baseUrl);
  }

  return null;
}

// ---------------------------------------------------------------------------
// RSS parsen
// ---------------------------------------------------------------------------

async function parseerRssTekst(tekst, bron) {
  const feed = await rssParser.parseString(tekst);
  return (feed.items || []).map((item) => {
    const foto = haalFotoUitRssItem(item);
    return {
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel: (item.title || "").trim(),
      url: item.link || "",
      samenvatting: schoonmakenSamenvatting(item.contentSnippet || item.content || ""),
      gepubliceerdOp: item.isoDate || item.pubDate || null,
      ...(foto ? { foto } : {}),
      opgehaaldOp: new Date().toISOString(),
    };
  });
}

function schoonmakenSamenvatting(tekst) {
  return tekst.replace(/\s+/g, " ").trim().slice(0, 600);
}

// ---------------------------------------------------------------------------
// Paginering
// ---------------------------------------------------------------------------

const MAX_PAGINAS = Number(process.env.MAX_PAGINAS || 10);
const PAGINA_PAUZE_MS = Number(process.env.PAGINA_PAUZE_MS || 500);

function tijdVan(iso) {
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

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
  if (lijstRichting(metDatum, "aflopend") === "aflopend" && start < beginNieuwsVenster()) {
    return `berichten zijn ouder dan het nieuwsvenster (laatste op deze pagina: ${datumTekst})`;
  }
  return null;
}

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
      if (n === 1) throw fout;
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
// Tekst (en foto) per bericht ophalen
// ---------------------------------------------------------------------------

const ARTIKEL_MAX_TEKENS = 3000;
const LIJSTTEKST_GENOEG_TEKENS = 600;
const MIN_BRUIKBARE_TEKST_TEKENS = 100;
const ARTIKEL_TIMEOUT_MS = 15_000;
const ARTIKEL_TOTAAL_TIMEOUT_MS = 40_000;
const ARTIKEL_PARALLEL = Number(process.env.ARTIKELTEKST_PARALLEL || 4);
const ARTIKEL_PAUZE_MS = Number(process.env.ARTIKELTEKST_PAUZE_MS || 400);
const ARTIKEL_MAX_SECONDEN = Number(process.env.ARTIKELTEKST_MAX_SECONDEN || 900);
const MAX_NETWERKFOUTEN_ACHTEREEN = 3;

const ARTIKEL_WEG =
  'script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  ".breadcrumb, .breadcrumbs, .share, .social, .cookie, .cookies, #cookie, .related, .comments";

const ARTIKEL_INHOUD_SELECTORS = [
  "article", "main", '[role="main"]', ".entry-content", ".post-content", ".article-content",
  ".article-body", ".node__content", ".content-main", "#content", ".content",
  "#me_CBCzqv", ".aandachtstekst__tekst",
];

function maakSchoneTekst(tekst) {
  return String(tekst || "").replace(/\s+/g, " ").trim();
}

function kortAf(tekst, max) {
  if (tekst.length <= max) return tekst;
  const stuk = tekst.slice(0, max);
  const laatsteSpatie = stuk.lastIndexOf(" ");
  return `${(laatsteSpatie > max - 150 ? stuk.slice(0, laatsteSpatie) : stuk).trim()}…`;
}

/**
 * Haalt de tekst én de foto uit de HTML van de berichtpagina. Puur: geen
 * netwerk. Geeft { tekst, methode, foto } terug of null als er helemaal niets
 * bruikbaars staat. `foto` kan ook gevuld zijn als `tekst` leeg is — een
 * pagina met alleen een afbeelding en geen tekst levert nog steeds een foto
 * voor de feed.
 */
function haalTekstUitHtml(html) {
  if (!html || String(html).startsWith("%PDF-")) return null;
  const $ = cheerio.load(html);

  // Foto eerst ophalen: de meta-tags staan in de <head>, die we hieronder niet
  // aanraken, maar het is netter om hem vóór alle andere operaties te lezen.
  const foto = haalFotoUitHtml($);

  const metaTeksten = [$('meta[property="og:description"]').attr("content"), $('meta[name="description"]').attr("content")]
    .map(maakSchoneTekst)
    .sort((a, b) => b.length - a.length);

  $(ARTIKEL_WEG).remove();
  $("p, li, h1, h2, h3, h4, h5, h6, br, div, tr, section").after("\n");

  let tekst = null;
  for (const selector of ARTIKEL_INHOUD_SELECTORS) {
    let langste = "";
    $(selector).each((_, el) => {
      const t = maakSchoneTekst($(el).text());
      if (t.length > langste.length) langste = t;
    });
    if (langste.length >= MIN_BRUIKBARE_TEKST_TEKENS) {
      tekst = kortAf(langste, ARTIKEL_MAX_TEKENS);
      break;
    }
  }
  if (!tekst && metaTeksten[0] && metaTeksten[0].length >= MIN_BRUIKBARE_TEKST_TEKENS) {
    tekst = kortAf(metaTeksten[0], ARTIKEL_MAX_TEKENS);
  }

  if (!tekst && !foto) return null;
  return {
    tekst: tekst || "",
    methode: tekst ? "artikel" : "alleen-foto",
    ...(foto ? { foto } : {}),
  };
}

function metTijdslimiet(belofte, ms, melding) {
  belofte.catch(() => {});
  let timer;
  const limiet = new Promise((_, afwijzen) => {
    timer = setTimeout(() => afwijzen(new Error(melding)), ms);
  });
  return Promise.race([belofte, limiet]).finally(() => clearTimeout(timer));
}

/**
 * Haalt de pagina van één bericht op en geeft { tekst, methode, foto } of null
 * als de pagina niets bruikbaars bevat. Gooit een fout als de pagina niet op
 * te halen was.
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
      console.log(`[tekst] Geen bruikbare tekst of foto op ${url} (HTML: ${html.length} tekens).`);
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
 * Vult samenvatting én foto van berichten aan met de gegevens van de
 * berichtpagina. Sinds Deel B: de pagina wordt ook opgehaald als de
 * samenvatting al lang genoeg is, maar er nog geen foto is — de pagina
 * levert dan alleen de foto (de bestaande, langere tekst wordt niet
 * overschreven). Lukt het ophalen niet, dan blijven de lijstgegevens staan;
 * het bericht gaat gewoon door. Fouten worden geteld en gelogd.
 *
 * De foto-telling gebeurt aan het einde in één keer (s.metFoto++ in de
 * eind-lus). Tijdens het ophalen wordt de teller NIET opgehoogd, anders zou
 * een foto dubbel geteld worden (één keer bij het zetten, één keer in de
 * eind-lus).
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
  const stat = (id) => (perBron[id] ||= { totaal: 0, metTekst: 0, metFoto: 0, opgehaald: 0, geenTekst: 0, fouten: 0, overgeslagen: 0 });

  const perHost = new Map();
  for (const b of berichten) {
    // Sla een bericht alleen over als de tekst AL lang genoeg is EN er al een
    // foto is. Is de tekst lang genoeg maar ontbreekt de foto nog, dan halen
    // we de pagina alsnog op — alleen voor de foto (de tekst wordt dan niet
    // overschreven, want de bestaande is al langer).
    const tekstGenoeg = (b.samenvatting || "").length >= lijsttekstGenoeg;
    const heeftFoto = Boolean(b.foto);
    if (tekstGenoeg && heeftFoto) continue;
    if (nietOphalen(b)) continue;
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
        if (uit && uit.foto && !b.foto) {
          b.foto = uit.foto;
          // De teller s.metFoto wordt NIET hier opgehoogd; dat gebeurt aan
          // het einde van deze functie, in de eind-lus. Anders zou een foto
          // dubbel geteld worden en zou de log "20 van 10 met foto" zeggen.
        }
        if (uit && uit.tekst && uit.tekst.length > (b.samenvatting || "").length) {
          b.samenvatting = uit.tekst;
          s.opgehaald++;
        } else {
          s.geenTekst++;
        }
      } catch (fout) {
        s.fouten++;
        if (s.fouten <= 3) log.warn(`[${b.bronId}] Tekst/foto ophalen mislukt voor ${b.url}: ${fout.message}${oorzaakTekst(fout)} — het bericht gaat door met de lijstgegevens.`);
        netwerkFoutenAchtereen = isNetwerkFout(fout) ? netwerkFoutenAchtereen + 1 : 0;
        if (netwerkFoutenAchtereen >= MAX_NETWERKFOUTEN_ACHTEREEN) {
          hostGestopt = true;
          log.warn(`[${b.bronId}] ${host} gaf ${MAX_NETWERKFOUTEN_ACHTEREEN} keer achter elkaar een netwerkfout; de overige berichten van deze site houden hun lijstgegevens.`);
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
  if (tijdOp) log.warn(`De tekststap stopte na ${maxSeconden}s; de overige berichten houden hun lijstgegevens.`);

  for (const b of berichten) {
    const s = stat(b.bronId);
    s.totaal++;
    if ((b.samenvatting || "").length >= MIN_BRUIKBARE_TEKST_TEKENS) s.metTekst++;
    if (b.foto) s.metFoto++;
  }
  return { perBron, tijdOp };
}

function tekstDekkingTekst(s) {
  return `${s.metTekst} van ${s.totaal} met tekst`;
}

function tekstStatistiekRegel(s) {
  const delen = [`${s.opgehaald} van de berichtpagina`, `${Math.max(0, s.metTekst - s.opgehaald)} uit de lijst`];
  if (s.geenTekst) delen.push(`${s.geenTekst} pagina('s) zonder bruikbare tekst`);
  if (s.fouten) delen.push(`${s.fouten} mislukt`);
  if (s.overgeslagen) delen.push(`${s.overgeslagen} overgeslagen`);
  if (s.metFoto) delen.push(`${s.metFoto} met foto`);
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
  beginNieuwsVenster,
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
  haalFotoUitRssItem,
  haalFotoUitHtml,
  haalFotoUitItem,
  maakAbsoluut,
  ARTIKEL_MAX_TEKENS,
  LIJSTTEKST_GENOEG_TEKENS,
  MIN_BRUIKBARE_TEKST_TEKENS,
};
