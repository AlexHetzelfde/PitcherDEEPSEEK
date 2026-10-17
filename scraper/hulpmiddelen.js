// hulpmiddelen.js
// Gedeelde functies die door meerdere scrapers gebruikt worden.
//
// Sinds de "tijdzone-en-logica"-ronde (2026-10-17):
//  - kalenderdagAmsterdam / vandaagAmsterdam / dagVerschil / kalenderdagMinDagen:
//    alle datumvergelijkingen gebeuren nu op kalenderdagen in Europe/Amsterdam.
//  - binnenLeeftijdsgrens heeft nu ook een bovengrens: datums in de toekomst
//    worden geweigerd.
//  - binnenAgendaVenster vergelijkt kalenderdagen i.p.v. tijdstippen.
//  - paginaVoorbij: bij een oplopende agenda kijkt de check nu naar de EERSTE
//    datum op de pagina (niet de laatste).
//  - volgPaginas logt de datumverdeling per kalenderdag.
//  - parseerRssTekst logt de kalenderdag-verdeling van de feed.
//  - vulBerichtenAanMetTekst zet per bericht tekstBron ("artikel" of "lijst").
//
// Sinds de "datum-en-debug"-ronde (2026-10-17):
//  - haalDatumUitTekst herkent nu ook DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY,
//    zodat teksten als "Geldend van 16-10-2026 t/m heden" wel worden geparsed.
//    Zonder deze fix gaf wetenregelgeving alle 50 items een lege datum.
//  - Optionele debug-logging via DEBUG_DATUM=1: logt per datum-parse welke
//    tekst welke datum oplevert. Handig om te controleren of de extractie
//    klopt zonder de hele run te vervuilen.

const cheerio = require("cheerio");
const Parser = require("rss-parser");
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
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const TZ = "Europe/Amsterdam";
const MAX_LEEFTIJD_DAGEN = 1;

function debugDatum() {
  const v = process.env.DEBUG_DATUM;
  return v === "1" || v === "ja" || v === "true";
}

// ---------------------------------------------------------------------------
// Kalenderdag-helpers (Amsterdam)
// ---------------------------------------------------------------------------

function kalenderdagAmsterdam(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

function vandaagAmsterdam() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

function dagVerschil(vanDag, totDag) {
  if (!vanDag || !totDag) return null;
  const a = new Date(vanDag + "T00:00:00Z").getTime();
  const b = new Date(totDag + "T00:00:00Z").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function kalenderdagMinDagen(dagen) {
  const vandaag = vandaagAmsterdam();
  const d = new Date(vandaag + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - dagen);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Vensters
// ---------------------------------------------------------------------------

function beginNieuwsVenster(nu = new Date()) {
  const beginVandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate()).getTime();
  return beginVandaag - MAX_LEEFTIJD_DAGEN * 24 * 60 * 60 * 1000;
}

function binnenLeeftijdsgrens(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return false;
  const dag = kalenderdagAmsterdam(gepubliceerdOpIso);
  if (!dag) return false;
  const verschil = dagVerschil(dag, vandaagAmsterdam());
  if (verschil === null) return false;
  return verschil >= 0 && verschil <= MAX_LEEFTIJD_DAGEN;
}

const AGENDA_MAX_VERLEDEN_DAGEN = 0;
const AGENDA_MAX_VOORUIT_DAGEN = 0;

function binnenAgendaVenster(gepubliceerdOpIso, eindDatumIso) {
  if (!gepubliceerdOpIso) return false;
  const startDag = kalenderdagAmsterdam(gepubliceerdOpIso);
  if (!startDag) return false;
  const verschilStart = dagVerschil(startDag, vandaagAmsterdam());
  if (verschilStart === null) return false;
  return verschilStart <= AGENDA_MAX_VERLEDEN_DAGEN && verschilStart >= -AGENDA_MAX_VOORUIT_DAGEN;
}

function binnenVenster(gepubliceerdOpIso, bron, eindDatumIso) {
  return bron && bron.soort === "agenda" ? binnenAgendaVenster(gepubliceerdOpIso, eindDatumIso) : binnenLeeftijdsgrens(gepubliceerdOpIso);
}

function leeftijdInDagen(gepubliceerdOpIso) {
  if (!gepubliceerdOpIso) return null;
  const datum = new Date(gepubliceerdOpIso);
  if (isNaN(datum.getTime())) return null;
  return (Date.now() - datum.getTime()) / (24 * 60 * 60 * 1000);
}

function oorzaakTekst(fout) {
  const oorzaak = fout && fout.cause;
  if (!oorzaak) return "";
  const code = oorzaak.code ? ` [${oorzaak.code}]` : "";
  const tekst = oorzaak.message || String(oorzaak);
  return ` — oorzaak: ${tekst}${code}`;
}

// ---------------------------------------------------------------------------
// Netwerk
// ---------------------------------------------------------------------------

const dispatcherCache = new Map();

async function haalDispatcherVoorHost(hostname, url) {
  if (dispatcherCache.has(hostname)) return dispatcherCache.get(hostname);
  const reparatie = await probeerKetenTeRepareren(url).catch(() => null);
  const dispatcher = reparatie ? reparatie.dispatcher : null;
  dispatcherCache.set(hostname, dispatcher);
  return dispatcher;
}

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

// ---------------------------------------------------------------------------
// Datum-parsing
// ---------------------------------------------------------------------------

const NEDERLANDSE_MAANDEN = {
  januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
  juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
};

const MAANDEN_LANG = "januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december";
const MAANDEN_KORT = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, okt: 9, nov: 10, dec: 11 };
const MAAND_ALLES = `${MAANDEN_LANG}|jan|feb|mrt|apr|jun|jul|aug|sept?|okt|nov|dec`;

function haalDatumUitTekst(tekst, opties = {}) {
  if (!tekst) return null;
  const bronTekst = typeof tekst === "string" ? tekst : String(tekst);

  // 1. ISO: YYYY-MM-DD
  const iso = bronTekst.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    if (!isNaN(d.getTime())) {
      if (debugDatum()) console.log(`[datum] ISO "${iso[0]}" → ${d.toISOString().slice(0, 10)}`);
      return d.toISOString();
    }
  }

  // 2. DMY: DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY (Nederlandse notatie)
  //    NIEUW: nodig voor teksten als "Geldend van 16-10-2026 t/m heden".
  //    We pakken de EERSTE match; dat is bij "geldend van X t/m Y" de
  //    ingangsdatum, wat de relevante datum is.
  const dmj = bronTekst.match(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/);
  if (dmj) {
    const dag = Number(dmj[1]);
    const maand = Number(dmj[2]) - 1;
    const jaar = Number(dmj[3]);
    const d = new Date(jaar, maand, dag);
    if (!isNaN(d.getTime()) && d.getMonth() === maand && d.getDate() === dag) {
      if (debugDatum()) console.log(`[datum] DMY "${dmj[0]}" → ${d.toISOString().slice(0, 10)}`);
      return d.toISOString();
    }
  }

  // 3. Nederlandse maandnaam: "16 oktober 2026"
  const nl = bronTekst.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MAANDEN_LANG})\\s+(\\d{4})(?!\\d)`, "i"));
  if (nl) {
    const maand = NEDERLANDSE_MAANDEN[nl[2].toLowerCase()];
    const d = new Date(Number(nl[3]), maand, Number(nl[1]));
    if (!isNaN(d.getTime())) {
      if (debugDatum()) console.log(`[datum] NL "${nl[0]}" → ${d.toISOString().slice(0, 10)}`);
      return d.toISOString();
    }
  }

  if (opties.zonderJaar) return haalDatumZonderJaar(bronTekst, opties.nu);
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
      if (bereik) {
        if (debugDatum()) console.log(`[datum] bereik (${modus}): "${String(tekst).slice(0, 80)}" → ${bereik.start} t/m ${bereik.eind || "(geen eind)"}`);
        return bereik;
      }
    }
    const datum = modus === "streng" ? parseerDatumTekst(tekst, opties) : haalDatumUitTekst(tekst, opties);
    if (datum) {
      if (debugDatum()) console.log(`[datum] match (${modus}): "${String(tekst).slice(0, 80)}" → ${datum.slice(0, 10)}`);
      return { start: datum, eind: null };
    }
  }
  if (debugDatum()) {
    const overzicht = kandidaten
      .map(([t, m]) => `${m}:${JSON.stringify(String(t || "").slice(0, 50))}`)
      .join(" | ");
    console.log(`[datum] geen match in kandidaten: ${overzicht}`);
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function haalOpEcht(url, pogingen = 3, opties = {}) {
  let laatsteFout;
  let dispatcher;
  const timeoutMs = opties.timeoutMs || 20_000;
  const { hostname } = new URL(url);

  const standaardHeaders = {
    "User-Agent": GEBRUIKERSAGENT,
    "Accept": "*/*",
    "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  };

  dispatcher = dispatcherCache.get(hostname) || undefined;

  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const fetchOpties = { headers: standaardHeaders, signal: controller.signal };
        if (dispatcher) fetchOpties.dispatcher = dispatcher;
        const response = await fetch(url, fetchOpties);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} voor ${url}`);
        }
        return await response.text();
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (fout) {
      laatsteFout = fout;

      if (
        fout.cause &&
        fout.cause.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" &&
        !dispatcherCache.get(hostname)
      ) {
        console.warn(`Certificaatketen van ${url} is onvolledig — probeer het ontbrekende tussencertificaat zelf op te halen...`);
        const nieuweDispatcher = await haalDispatcherVoorHost(hostname, url);
        if (nieuweDispatcher) {
          console.warn(`Ontbrekend tussencertificaat gevonden voor ${hostname}; deze wordt voor de rest van de run hergebruikt.`);
          dispatcher = nieuweDispatcher;
          continue;
        }
      }

      if (fout.cause && fout.cause.message === "redirect count exceeded") {
        console.warn(`${url} stuurt eindeloos door (waarschijnlijk is een sessie-cookie vereist) — probeer met cookie-ondersteuning...`);
        try {
          const cookieOpties = { headers: standaardHeaders };
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

function urlUitMediaKnoop(knoop) {
  if (!knoop) return null;
  if (typeof knoop === "string") return knoop;
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

function haalFotoUitHtml($) {
  const og = $('meta[property="og:image"]').attr("content") || $('meta[property="og:image:secure_url"]').attr("content");
  if (og) return og.trim();
  const tw = $('meta[name="twitter:image"]').attr("content") || $('meta[name="twitter:image:src"]').attr("content");
  if (tw) return tw.trim();
  const link = $('link[rel="image_src"]').attr("href");
  if (link) return link.trim();
  return null;
}

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

  const srcset = imgEl.attr("srcset");
  if (typeof srcset === "string" && srcset.trim()) {
    const eerste = srcset.split(",")[0].trim().split(/\s+/)[0];
    if (bruikbaar(eerste)) return maakAbsoluut(eerste, baseUrl);
  }

  return null;
}

// ---------------------------------------------------------------------------
// ID-titels
// ---------------------------------------------------------------------------

const ID_TITEL_PATROON = /^(?:[a-z]{2,5}-\d{4}-\d+\s*[:\-].*|[a-z]{2,5}-\d{4}-\d+|ECLI:[A-Z]{2}:[A-Z]+:\d{4}:\d+)$/i;

function titelIsId(titel) {
  if (!titel) return true;
  const t = String(titel).trim();
  if (t.length < 3) return true;
  return ID_TITEL_PATROON.test(t);
}

function kiesRssTitel(item) {
  const titel = (item.title || "").trim();
  if (!titelIsId(titel)) return titel;

  const kandidaten = [item.description, item.summary, item.contentSnippet, item.content];
  for (const ruw of kandidaten) {
    if (!ruw) continue;
    const plat = String(ruw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (plat.length < 10) continue;
    const zonderId = plat.replace(/^[a-z]{2,5}-\d{4}-\d+\s*[:\-]\s*/i, "").trim();
    if (zonderId.length >= 10) return zonderId.slice(0, 200);
  }
  return titel;
}

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

function logRssDatums(bronId, items) {
  const perDag = new Map();
  for (const item of items) {
    const dag = kalenderdagAmsterdam(item.gepubliceerdOp);
    if (dag) perDag.set(dag, (perDag.get(dag) || 0) + 1);
  }
  if (perDag.size === 0) {
    console.log(`[${bronId}] RSS: ${items.length} items, geen leesbare datums.`);
    return;
  }
  const gesorteerd = [...perDag.entries()].sort();
  if (gesorteerd.length === 1) {
    console.log(`[${bronId}] RSS: ${items.length} items, alle op ${gesorteerd[0][0]} (${gesorteerd[0][1]}x).`);
  } else {
    const eerste = gesorteerd[0];
    const laatste = gesorteerd[gesorteerd.length - 1];
    console.log(`[${bronId}] RSS: ${items.length} items, van ${eerste[0]} (${eerste[1]}x) t/m ${laatste[0]} (${laatste[1]}x).`);
  }
}

async function parseerRssTekst(tekst, bron) {
  const feed = await rssParser.parseString(tekst);
  const items = (feed.items || []).map((item) => {
    const foto = haalFotoUitRssItem(item);
    return {
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel: kiesRssTitel(item),
      url: item.link || "",
      samenvatting: schoonmakenSamenvatting(item.contentSnippet || item.content || ""),
      gepubliceerdOp: item.isoDate || item.pubDate || null,
      ...(foto ? { foto } : {}),
      opgehaaldOp: new Date().toISOString(),
    };
  });
  if (items.length > 0 && bron && bron.id) {
    logRssDatums(bron.id, items);
  }
  return items;
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

function beschrijfDatumVerdeling(berichten) {
  const perDag = new Map();
  for (const b of berichten) {
    const dag = kalenderdagAmsterdam(b.gepubliceerdOp);
    if (dag) perDag.set(dag, (perDag.get(dag) || 0) + 1);
  }
  if (perDag.size === 0) return "geen datums";
  const gesorteerd = [...perDag.entries()].sort();
  if (gesorteerd.length <= 4) {
    return gesorteerd.map(([d, n]) => `${d} (${n}x)`).join(", ");
  }
  const eerste = gesorteerd[0];
  const laatste = gesorteerd[gesorteerd.length - 1];
  return `${eerste[0]} (${eerste[1]}x) t/m ${laatste[0]} (${laatste[1]}x)`;
}

function paginaVoorbij(bron, paginaBerichten, nu = Date.now()) {
  const metDatum = paginaBerichten.filter((b) => tijdVan(b.gepubliceerdOp) !== null);
  if (metDatum.length === 0) return "geen enkel bericht op deze pagina heeft een datum (zulke berichten worden toch geweerd)";

  const vandaag = vandaagAmsterdam();
  const eerste = metDatum[0];
  const laatste = metDatum[metDatum.length - 1];
  const eersteDag = kalenderdagAmsterdam(eerste.gepubliceerdOp);
  const laatsteDag = kalenderdagAmsterdam(laatste.gepubliceerdOp);

  if (bron.soort === "agenda") {
    const richting = lijstRichting(metDatum, "oplopend");
    if (richting === "oplopend" && eersteDag > vandaag) {
      return `agenda is voorbij het venster (eerste evenement op deze pagina: ${eersteDag}, na vandaag)`;
    }
    if (richting === "aflopend" && laatsteDag < vandaag) {
      return `agenda is voorbij het venster (laatste evenement op deze pagina: ${laatsteDag}, al voorbij)`;
    }
    return null;
  }

  const grensDag = kalenderdagMinDagen(MAX_LEEFTIJD_DAGEN);
  if (lijstRichting(metDatum, "aflopend") === "aflopend" && laatsteDag < grensDag) {
    return `berichten zijn ouder dan het nieuwsvenster (laatste op deze pagina: ${laatsteDag}, grens ${grensDag})`;
  }
  return null;
}

function vindVolgendePagina($, paginaUrl, huidigNummer, paginering) {
  if (paginering && paginering.soort === "geen") return null;

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

    log.log(`[${bron.id}] pagina ${n}: ${pagina.length} bericht(en), ${nieuw.length} nieuw; datums: ${beschrijfDatumVerdeling(pagina)}.`);

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
// Artikeltekst
// ---------------------------------------------------------------------------

const ARTIKEL_TIMEOUT_MS = Number(process.env.ARTIKELTEKST_TIMEOUT_MS || 30_000);
const ARTIKEL_TOTAAL_TIMEOUT_MS = Number(process.env.ARTIKELTEKST_TOTAAL_TIMEOUT_MS || 90_000);
const ARTIKEL_PARALLEL = Number(process.env.ARTIKELTEKST_PARALLEL || 4);
const ARTIKEL_PAUZE_MS = Number(process.env.ARTIKELTEKST_PAUZE_MS || 2_500);
const ARTIKEL_MAX_SECONDEN = Number(process.env.ARTIKELTEKST_MAX_SECONDEN || 1_800);
const MAX_NETWERKFOUTEN_ACHTEREEN = Number(process.env.ARTIKELTEKST_MAX_NETWERKFOUTEN || 5);

const ARTIKEL_MAX_TEKENS = 3000;
const LIJSTTEKST_GENOEG_TEKENS = 600;
const MIN_BRUIKBARE_TEKST_TEKENS = 100;

const ARTIKEL_WEG =
  'script, style, noscript, svg, iframe, nav, footer, header, aside, form, button, select, ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
  ".breadcrumb, .breadcrumbs, .share, .social, .cookie, .cookies, #cookie, .related, .comments";

const ARTIKEL_INHOUD_SELECTORS = [
  ".text-content-section",
  ".aandachtstekst__tekst",
  ".entry-content",
  ".post-content",
  ".article-content",
  ".article-body",
  ".node__content",
  ".content-main",
  "article",
  '[role="main"]',
  "main",
  "#content",
  ".content",
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

function stripDubbeleTitel(tekst, titel) {
  const t = maakSchoneTekst(titel);
  if (!t || t.length < 12) return tekst;
  const prefix = tekst.slice(0, t.length);
  if (prefix.toLowerCase() === t.toLowerCase()) {
    return tekst.slice(t.length).replace(/^[\s\-–—:.,;•·]+/, "").trim();
  }
  return tekst;
}

function haalTekstUitHtml(html, opties = {}) {
  if (!html || String(html).startsWith("%PDF-")) return null;
  const $ = cheerio.load(html);

  const foto = haalFotoUitHtml($);

  const metaTeksten = [$('meta[property="og:description"]').attr("content"), $('meta[name="description"]').attr("content")]
    .map(maakSchoneTekst)
    .sort((a, b) => b.length - a.length);

  $(ARTIKEL_WEG).remove();
  $("p, li, h1, h2, h3, h4, h5, h6, br, div, tr, section").after("\n");

  const kandidaten = [];
  if (opties.detailSelector && typeof opties.detailSelector === "string" && opties.detailSelector.trim()) {
    kandidaten.push(opties.detailSelector.trim());
  }
  kandidaten.push(...ARTIKEL_INHOUD_SELECTORS);

  let tekst = null;
  for (const selector of kandidaten) {
    let langste = "";
    try {
      $(selector).each((_, el) => {
        const t = maakSchoneTekst($(el).text());
        if (t.length > langste.length) langste = t;
      });
    } catch {
      continue;
    }
    if (langste.length >= MIN_BRUIKBARE_TEKST_TEKENS) {
      const schoon = opties.titel ? stripDubbeleTitel(langste, opties.titel) : langste;
      tekst = kortAf(schoon, ARTIKEL_MAX_TEKENS);
      break;
    }
  }
  if (!tekst && metaTeksten[0] && metaTeksten[0].length >= MIN_BRUIKBARE_TEKST_TEKENS) {
    const schoon = opties.titel ? stripDubbeleTitel(metaTeksten[0], opties.titel) : metaTeksten[0];
    tekst = kortAf(schoon, ARTIKEL_MAX_TEKENS);
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

async function haalArtikelTekst(url, opties = {}) {
  if (!url || /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif)(\?|#|$)/i.test(url)) return null;
  try {
    const html = await metTijdslimiet(
      haalOp(url, 2, { stil: true, timeoutMs: ARTIKEL_TIMEOUT_MS }),
      ARTIKEL_TOTAAL_TIMEOUT_MS,
      `timeout na ${ARTIKEL_TOTAAL_TIMEOUT_MS / 1000}s bij het ophalen van ${url}`
    );
    const resultaat = haalTekstUitHtml(html, opties);
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

async function vulBerichtenAanMetTekst(berichten, opties = {}) {
  const {
    nietOphalen = () => false,
    haalTekst = haalArtikelTekst,
    log = console,
    lijsttekstGenoeg = LIJSTTEKST_GENOEG_TEKENS,
    parallel = ARTIKEL_PARALLEL,
    pauzeMs = ARTIKEL_PAUZE_MS,
    maxSeconden = ARTIKEL_MAX_SECONDEN,
    detailSelectorVoor = null,
  } = opties;

  const perBron = {};
  const stat = (id) => (perBron[id] ||= { totaal: 0, metTekst: 0, metFoto: 0, opgehaald: 0, geenTekst: 0, fouten: 0, overgeslagen: 0 });

  const perHost = new Map();
  for (const b of berichten) {
    const tekstGenoeg = (b.samenvatting || "").length >= lijsttekstGenoeg;
    const heeftFoto = Boolean(b.foto);
    if (tekstGenoeg && heeftFoto) {
      b.tekstBron = "lijst";
      continue;
    }
    if (nietOphalen(b)) {
      b.tekstBron = "lijst";
      continue;
    }
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
        b.tekstBron = "lijst";
        continue;
      }
      if (Date.now() > einde) {
        tijdOp = true;
        s.overgeslagen++;
        b.tekstBron = "lijst";
        continue;
      }
      try {
        const detailSelector =
          b.detailSelector ?? (typeof detailSelectorVoor === "function" ? detailSelectorVoor(b) : null);
        const uit = await haalTekst(b.url, { titel: b.titel, detailSelector });
        netwerkFoutenAchtereen = 0;
        if (uit && uit.foto && !b.foto) {
          b.foto = uit.foto;
        }
        if (uit && uit.tekst && uit.tekst.length > (b.samenvatting || "").length) {
          b.samenvatting = uit.tekst;
          b.tekstBron = "artikel";
          s.opgehaald++;
        } else {
          b.tekstBron = "lijst";
          s.geenTekst++;
        }
      } catch (fout) {
        s.fouten++;
        b.tekstBron = "lijst";
        if (s.fouten <= 5) log.warn(`[${b.bronId}] Tekst/foto ophalen mislukt voor ${b.url}: ${fout.message}${oorzaakTekst(fout)} — het bericht gaat door met de lijstgegevens.`);
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
    if (b.tekstBron === "artikel" && (b.samenvatting || "").length >= MIN_BRUIKBARE_TEKST_TEKENS) s.metTekst++;
    if (b.foto) s.metFoto++;
  }
  return { perBron, tijdOp };
}

function tekstDekkingTekst(s) {
  return `${s.metTekst} van ${s.totaal} met artikeltekst`;
}

function tekstStatistiekRegel(s) {
  const uitLijst = Math.max(0, s.totaal - s.opgehaald);
  const delen = [`${s.opgehaald} van de berichtpagina`];
  if (uitLijst > 0) delen.push(`${uitLijst} uit de lijst`);
  if (s.geenTekst) delen.push(`${s.geenTekst} pagina('s) zonder bruikbare tekst`);
  if (s.fouten) delen.push(`${s.fouten} mislukt`);
  if (s.overgeslagen) delen.push(`${s.overgeslagen} overgeslagen`);
  if (s.metFoto) delen.push(`${s.metFoto} met foto`);
  return `${s.metTekst} van ${s.totaal} met artikeltekst (${delen.join(", ")})`;
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
  TZ,
  MAX_LEEFTIJD_DAGEN,
  AGENDA_MAX_VERLEDEN_DAGEN,
  AGENDA_MAX_VOORUIT_DAGEN,
  kalenderdagAmsterdam,
  vandaagAmsterdam,
  dagVerschil,
  kalenderdagMinDagen,
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
  stripDubbeleTitel,
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
  ID_TITEL_PATROON,
  titelIsId,
  kiesRssTitel,
};
