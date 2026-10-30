// script.js — front-end logica
//
// Leest statische JSON-bestanden die de GitHub Actions-workflows verversen:
//   data/berichten.json     de nieuwsstroom (ZANP, elk half uur)
//   data/agenda.json        de weekagenda (ZANP, elk half uur)
//   data/zanp-status.json   laatste ZANP-run en bronstatus (voor de statusregel)
//   data/pitches.json, data/feed.json, data/nieuws-lokaal.json,
//   data/nieuws-landelijk.json   de pitchmachine (tab Pitches, elke nacht)
//
// De ZANP-tabs verversen zichzelf elke 5 minuten zolang de pagina zichtbaar
// is; de pitchtab wordt één keer geladen.
//
// Opzet (ZANP, indeling van het ANP-nieuwsscherm, 2026-10-30):
//  - Nieuwsdienst: een kolom van 20rem per tag plus een totaalkolom (naar het ANP).
//    Elke kolom heeft een zoek-icoon (opent een eigen zoekveld) en een menu (⋮) en
//    toont standaard de laatste drie dagen
//    (zoeken doorzoekt alles, "Oudere berichten" laat de rest zien). Dubbel
//    nieuws staat als één bericht met "ook gemeld door"; berichten over dezelfde
//    zaak (zelfde adres, ECLI, zaaknummer) verwijzen naar elkaar. Alerts staan
//    in een rode of oranje regel bovenaan. Kolommen zijn aan en uit te zetten
//    (wordt onthouden); op een telefoon kies je één kolom met tabs.
//  - Agenda: "‹ Vandaag ›" en zeven dagkolommen (maandag tot en met zondag; op
//    een telefoon onder elkaar). Wat het agendafilter wegliet staat achter de
//    kleine knop "+N gefilterd" (of #agenda?alles=1). Een T bij een agendapunt
//    opent het bericht erover.
//  - Week en agendafilter staan in de url (#agenda?week=1&alles=1).
//  - Pitches: ongewijzigd.
//  - escapeHtml escapet ook aanhalingstekens; links zijn alleen http(s).

const TIJDZONE = "Europe/Amsterdam";
const TABS = ["nieuwsdienst", "agenda", "pitches"];
const VERVERS_MS = 5 * 60 * 1000;
const VEROUDERD_MINUTEN = 90;

const ZOEK_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
const MENU_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>';
const KLOK_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
  + '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// Voorkeuren in de browser. Mag falen (privé-modus, geblokkeerde opslag).
function leesOpslag(sleutel, standaard) {
  try {
    const waarde = window.localStorage.getItem(sleutel);
    return waarde === null ? standaard : JSON.parse(waarde);
  } catch {
    return standaard;
  }
}

function bewaarOpslag(sleutel, waarde) {
  try {
    window.localStorage.setItem(sleutel, JSON.stringify(waarde));
  } catch {
    /* niet erg: de voorkeur geldt dan alleen voor dit bezoek */
  }
}

const state = {
  berichten: [],
  zichtbaar: [], // berichten na het samenvoegen van dubbel nieuws
  perGroep: new Map(),
  rubrieken: [],
  alertModus: "log",
  berichtenGegenereerdOp: null,
  agenda: [],
  agendaPerId: new Map(),
  status: null,
  agendaOffset: 0,
  agendaDag: null, // dag waar de agenda naartoe moet scrollen, eenmalig
  agendaRubriek: "",
  agendaToonAlles: false,
  zoek: {}, // kolomcode -> zoektekst
  zoekOpen: new Set(), // kolommen waar het zoekveld open staat
  oudere: new Set(), // kolommen waar ook de berichten van vóór de laatste drie dagen staan
  mobileKolom: "ALL",
  kolommenUit: new Set(leesOpslag("zanp-kolommen-uit", [])),
  weggeklikt: new Set(leesOpslag("zanp-alerts-weg", [])),
  bezoekStart: leesOpslag("zanp-laatst-bezocht", null),
  actieveTab: "nieuwsdienst",
};

// ---------------------------------------------------------------------------
// Algemene hulpfuncties
// ---------------------------------------------------------------------------

async function laadJson(pad) {
  // "no-cache": de browser vraagt de server of het bestand veranderd is en
  // krijgt anders een snelle 304 terug. Zo kost verversen elke 5 minuten weinig.
  const response = await fetch(pad, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Kon ${pad} niet laden (HTTP ${response.status})`);
  return response.json();
}

function escapeHtml(tekst) {
  return String(tekst ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Alleen http(s)-links; alles anders (javascript:, data:) wordt "#".
function veiligeUrl(url) {
  try {
    const u = new URL(url, window.location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "#";
  } catch {
    return "#";
  }
}

function formatteerDatum(isoTekst) {
  if (!isoTekst) return "datum onbekend";
  const datum = new Date(isoTekst);
  if (isNaN(datum.getTime())) return "datum onbekend";

  const tijdInAmsterdam = datum.toLocaleTimeString("nl-NL", {
    timeZone: TIJDZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const isMiddernacht = tijdInAmsterdam === "00:00";

  const opties = {
    day: "numeric",
    month: "short",
    timeZone: TIJDZONE,
  };
  if (!isMiddernacht) {
    opties.hour = "2-digit";
    opties.minute = "2-digit";
  }
  return datum.toLocaleString("nl-NL", opties);
}

// Kalenderdag (JJJJ-MM-DD) op de Amsterdamse klok.
function dagVan(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("sv-SE", { timeZone: TIJDZONE });
}

function vandaagDag() {
  return dagVan(new Date().toISOString());
}

function tijdVan(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("nl-NL", { timeZone: TIJDZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function dagPlus(dag, aantal) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + aantal);
  return d.toISOString().slice(0, 10);
}

function datumKort(dag) {
  return new Date(`${dag}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: "UTC" });
}

function dagMetWeekdag(dag) {
  return new Date(`${dag}T12:00:00Z`).toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function dagLabel(dag) {
  const vandaag = vandaagDag();
  if (dag === vandaag) return "Vandaag";
  if (dag === dagPlus(vandaag, -1)) return "Gisteren";
  return dagMetWeekdag(dag);
}

function maandagVan(dag) {
  const d = new Date(`${dag}T12:00:00Z`);
  return dagPlus(dag, -((d.getUTCDay() + 6) % 7));
}

function isoWeekNummer(dag) {
  const d = new Date(`${dag}T12:00:00Z`);
  const donderdag = new Date(d);
  donderdag.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jaarStart = new Date(Date.UTC(donderdag.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((donderdag - jaarStart) / 86400000 - 3 + ((jaarStart.getUTCDay() + 6) % 7)) / 7);
}

function minutenVan(iso) {
  const [u, m] = tijdVan(iso).split(":").map(Number);
  return u * 60 + m;
}

function foutmeldingHtml(fout, onderwerp) {
  return `<p class="foutmelding">${escapeHtml(onderwerp)} kon niet geladen worden: ${escapeHtml(fout.message)}</p>`;
}

function nogGeenDataHtml(fout, bericht) {
  // Voor de eerste workflow-run bestaat het bestand nog niet (HTTP 404).
  if (/404/.test(fout.message)) return `<p class="leeg">${escapeHtml(bericht)}</p>`;
  return foutmeldingHtml(fout, "De gegevens");
}

// ---------------------------------------------------------------------------
// Tabs en url
// ---------------------------------------------------------------------------

function parseHash() {
  const h = window.location.hash.slice(1);
  const i = h.indexOf("?");
  return { tab: i < 0 ? h : h.slice(0, i), params: new URLSearchParams(i < 0 ? "" : h.slice(i + 1)) };
}

function schrijfHash() {
  const p = new URLSearchParams();
  if (state.actieveTab === "agenda") {
    if (state.agendaOffset) p.set("week", String(state.agendaOffset));
    if (state.agendaRubriek) p.set("r", state.agendaRubriek);
    if (state.agendaToonAlles) p.set("alles", "1");
  }
  const tekst = p.toString();
  history.replaceState(null, "", `#${state.actieveTab}${tekst ? `?${tekst}` : ""}`);
}

function pasParamsToe(tab, params) {
  if (tab === "agenda") {
    const week = Number(params.get("week"));
    state.agendaOffset = Number.isInteger(week) ? Math.max(-12, Math.min(12, week)) : 0;
    state.agendaRubriek = params.get("r") || "";
    state.agendaToonAlles = params.get("alles") === "1";
  }
}

function toonTab(naam, opties = {}) {
  const gekozen = TABS.includes(naam) ? naam : "nieuwsdienst";
  state.actieveTab = gekozen;
  for (const tab of TABS) {
    const knop = document.getElementById(`tab-${tab}`);
    const paneel = document.getElementById(`paneel-${tab}`);
    const actief = tab === gekozen;
    knop.setAttribute("aria-selected", actief ? "true" : "false");
    knop.tabIndex = actief ? 0 : -1;
    paneel.hidden = !actief;
  }
  const kiezer = document.getElementById("kolommenkiezer");
  if (kiezer) kiezer.hidden = gekozen !== "nieuwsdienst";
  if (opties.schrijfHash !== false) schrijfHash();
}

function koppelTabs() {
  const knoppen = TABS.map((t) => document.getElementById(`tab-${t}`));
  knoppen.forEach((knop, index) => {
    knop.addEventListener("click", () => toonTab(knop.dataset.tab));
    knop.addEventListener("keydown", (e) => {
      const vooruit = e.key === "ArrowRight" || e.key === "ArrowDown";
      const terug = e.key === "ArrowLeft" || e.key === "ArrowUp";
      if (!vooruit && !terug) return;
      e.preventDefault();
      const volgende = (index + (vooruit ? 1 : -1) + knoppen.length) % knoppen.length;
      toonTab(knoppen[volgende].dataset.tab);
      knoppen[volgende].focus();
    });
  });
  window.addEventListener("hashchange", () => {
    const { tab, params } = parseHash();
    pasParamsToe(tab, params);
    toonTab(tab, { schrijfHash: false });
    if (tab === "nieuwsdienst") renderWire();
    if (tab === "agenda") renderAgenda();
  });
  const { tab, params } = parseHash();
  pasParamsToe(tab, params);
  toonTab(tab, { schrijfHash: false });
}

// ---------------------------------------------------------------------------
// Nieuwsdienst
// ---------------------------------------------------------------------------

const HERKOMST_RANG = { officieel: 0, organisatie: 1, signaal: 2, onbekend: 3 };

// Oude data heeft het veld "soort" in plaats van "herkomst".
function herkomstVan(r) {
  return r.herkomst || r.soort || "onbekend";
}

function kiesPrimair(leden) {
  return [...leden].sort((a, b) => {
    const h = (HERKOMST_RANG[herkomstVan(a)] ?? 3) - (HERKOMST_RANG[herkomstVan(b)] ?? 3);
    if (h !== 0) return h;
    return String(a.eerstGezienOp) < String(b.eerstGezienOp) ? -1 : 1;
  })[0];
}

// Zet de berichten in de state en voegt dubbel nieuws samen: per cluster blijft
// het bericht van de beste bron over, met een lijst "ook gemeld door".
function zetBerichten(data) {
  const d = data || {};
  state.berichten = Array.isArray(d.berichten) ? d.berichten : [];
  state.rubrieken = Array.isArray(d.rubrieken) ? d.rubrieken : [];
  state.alertModus = d.alertModus === "aan" ? "aan" : "log";
  state.berichtenGegenereerdOp = d.gegenereerdOp || null;

  const nieuwste = new Map();
  for (const r of state.berichten) {
    const v = nieuwste.get(r.groepId);
    if (!v || (r.versie || 1) > (v.versie || 1)) nieuwste.set(r.groepId, r);
  }
  state.perGroep = nieuwste;

  const perCluster = new Map();
  for (const r of nieuwste.values()) {
    if (!r.clusterId) continue;
    if (!perCluster.has(r.clusterId)) perCluster.set(r.clusterId, []);
    perCluster.get(r.clusterId).push(r);
  }
  const primair = new Map();
  const ook = new Map();
  for (const [clusterId, leden] of perCluster) {
    if (leden.length < 2) continue;
    const p = kiesPrimair(leden);
    primair.set(clusterId, p.groepId);
    ook.set(p.groepId, leden.filter((l) => l.groepId !== p.groepId).map((l) => ({ bronNaam: l.bronNaam, url: l.url })));
  }
  state.zichtbaar = state.berichten
    .filter((r) => !r.clusterId || !primair.has(r.clusterId) || primair.get(r.clusterId) === r.groepId)
    .map((r) => (ook.has(r.groepId) ? { ...r, ookGemeld: ook.get(r.groepId) } : r));
}

// De laatste drie dagen (vandaag en twee dagen terug) staan standaard in de kolom.
const WIRE_DAGEN = 2;

// Berichten van één kolom. Zoeken doorzoekt alles; zonder zoeken staan de oudere
// berichten achter "Oudere berichten". `ouder` is het aantal dat nu verborgen is.
function kolomBerichten(code) {
  const zoek = String(state.zoek[code] || "").trim().toLowerCase();
  const ondergrens = zoek || state.oudere.has(code) ? null : dagPlus(vandaagDag(), -WIRE_DAGEN);
  const lijst = [];
  let ouder = 0;
  for (const r of state.zichtbaar) {
    if (code !== "ALL" && r.rubriek !== code) continue;
    if (ondergrens && (dagVan(r.tijd) || "") < ondergrens) {
      ouder++;
      continue;
    }
    if (zoek) {
      const ook = (r.ookGemeld || []).map((x) => x.bronNaam).join(" ");
      const hooi = `${r.kop} ${r.tekst || ""} ${r.bronNaam || ""} ${ook}`.toLowerCase();
      if (!hooi.includes(zoek)) continue;
    }
    lijst.push(r);
  }
  return { lijst, ouder, zoekt: Boolean(zoek) };
}

// --- alerts -----------------------------------------------------------------

function actieveAlerts() {
  if (state.alertModus !== "aan") return [];
  const nu = Date.now();
  return state.berichten
    .filter((r) => r.alert && new Date(r.alert.tot).getTime() > nu)
    .sort((a, b) => {
      if (a.alert.niveau !== b.alert.niveau) return a.alert.niveau === "rood" ? -1 : 1;
      return String(b.alert.aangemaaktOp) < String(a.alert.aangemaaktOp) ? -1 : 1;
    });
}

function alertSleutel(r) {
  return `${r.groepId}|${r.alert.aangemaaktOp}|${r.alert.niveau}`;
}

function renderAlertBalk() {
  const container = document.getElementById("alert-balk");
  const lijst = actieveAlerts().filter((r) => !state.weggeklikt.has(alertSleutel(r)));
  container.innerHTML = lijst
    .map((r) => {
      const rood = r.alert.niveau === "rood";
      return `
        <div class="alert alert-${rood ? "rood" : "oranje"}">
          <button type="button" class="alert-open" data-actie="open-bericht" data-id="${escapeHtml(r.id)}">
            <strong class="alert-label">${rood ? "ALERT" : "Mogelijk groot"}</strong>
            <span class="alert-kop">${escapeHtml(r.kop)}</span>
            <span class="alert-reden">${escapeHtml(r.alert.reden)}</span>
          </button>
          <button type="button" class="alert-sluit" data-actie="sluit-alert" data-sleutel="${escapeHtml(alertSleutel(r))}" aria-label="Alert sluiten">×</button>
        </div>`;
    })
    .join("");
}

// --- kolommen ---------------------------------------------------------------

// Alle kolommen die er kunnen zijn: totaal + rubrieken met berichten.
function alleKolommen() {
  const lijst = [{ code: "ALL", naam: "ZANP totaal" }];
  for (const rubriek of state.rubrieken) {
    if (state.zichtbaar.some((r) => r.rubriek === rubriek.code)) lijst.push(rubriek);
  }
  return lijst;
}

// De kolommen die de gebruiker niet heeft uitgezet; nooit nul.
function getoondeKolommen() {
  const alle = alleKolommen();
  const aan = alle.filter((k) => !state.kolommenUit.has(k.code));
  return aan.length ? aan : alle.slice(0, 1);
}

function renderKolommenKiezer() {
  const container = document.getElementById("kolommen-opties");
  const aan = new Set(getoondeKolommen().map((k) => k.code));
  container.innerHTML = alleKolommen()
    .map(
      (k) => `
      <label class="vinkje">
        <input type="checkbox" data-actie="kolom-aan" data-kolom="${escapeHtml(k.code)}"${aan.has(k.code) ? " checked" : ""}>
        <span>${escapeHtml(k.naam)}</span>
      </label>`
    )
    .join("");
}

function renderKolomTabs() {
  const container = document.getElementById("kolom-tabs");
  const kolommen = getoondeKolommen();
  if (!kolommen.some((k) => k.code === state.mobileKolom)) state.mobileKolom = kolommen[0].code;
  container.innerHTML = kolommen
    .map(
      (k) =>
        `<button type="button" class="kolom-tab${k.code === state.mobileKolom ? " actief" : ""}" data-actie="kolom-tab" data-kolom="${escapeHtml(k.code)}" aria-pressed="${k.code === state.mobileKolom}">${escapeHtml(k.naam)}</button>`
    )
    .join("");
}

// --- agenda van vandaag, voor de balk bovenaan een kolom -----------------------

function agendaItemZichtbaar(i, toonAlles) {
  return toonAlles || (i.zichtbaar !== false && !i.inAfwachting);
}

function agendaVandaagInfo(rubriekCode) {
  const vandaag = vandaagDag();
  const items = state.agenda.filter(
    (i) =>
      agendaItemZichtbaar(i, false)
      && i.startDag <= vandaag
      && vandaag <= i.eindDag
      && i.status !== "VERVALLEN"
      && (!rubriekCode || i.rubriek === rubriekCode)
  );
  const metTijd = items.filter((i) => i.heeftTijd && i.startDag === vandaag);
  let bereik = "";
  if (metTijd.length > 0) {
    // Een eindtijd op een latere dag (doorlopend evenement) hoort niet in
    // het bereik van vandaag; dan telt alleen de begintijd.
    const eindVandaag = (i) => (i.eind && dagVan(i.eind) === vandaag ? i.eind : i.start);
    const eerste = metTijd.reduce((a, b) => (a.start < b.start ? a : b));
    const laatste = metTijd.reduce((a, b) => (eindVandaag(a) > eindVandaag(b) ? a : b));
    const eind = tijdVan(eindVandaag(laatste));
    bereik = tijdVan(eerste.start) === eind ? tijdVan(eerste.start) : `${tijdVan(eerste.start)} – ${eind}`;
  }
  return { aantal: items.length, bereik };
}

// --- één bericht ---------------------------------------------------------------

function renderWireDetail(r) {
  const delen = [];
  if (r.alert && state.alertModus === "aan") {
    delen.push(`<p><span class="wire-label waarschuwing">${r.alert.niveau === "rood" ? "Alert" : "Mogelijk groot"}</span>${escapeHtml(r.alert.reden)}</p>`);
  }
  if (r.tekst) delen.push(`<p>${escapeHtml(r.tekst)}</p>`);

  const herkomst = herkomstVan(r);
  if (r.ai && r.tekst) {
    delen.push('<p><span class="wire-label ai">AI</span>Automatisch samengevat uit de bron. Controleer de feiten voor gebruik.</p>');
  } else if (herkomst === "signaal") {
    delen.push('<p><span class="wire-label signaal">Signaal</span>Artikel of agenda van een andere redactie: alleen de kop en een link. Lees het artikel via de bron.</p>');
  } else if (r.controle === "cijfers-afgekeurd") {
    delen.push('<p><span class="wire-label waarschuwing">Afgekeurd</span>De AI-samenvatting bevatte een getal dat niet in de bron staat. Dit is de originele kop.</p>');
  } else if (r.controle === "ai-onvoldoende-tekst") {
    delen.push("<p>De brontekst was te kort voor een samenvatting. Open de bron voor de details.</p>");
  } else if (herkomst === "onbekend") {
    delen.push("<p>Alleen de kop en een link: deze bron heeft nog geen instellingen in rubrieken.json.</p>");
  } else if (r.seed) {
    delen.push("<p>Alleen de kop: dit bericht is bij de start van de nieuwsdienst overgenomen uit de feed.</p>");
  } else {
    delen.push("<p>Nog geen samenvatting beschikbaar.</p>");
  }

  if (r.versie > 1) {
    delen.push("<p>Nieuwe versie van een eerder bericht. De tijd is het moment waarop de wijziging is opgemerkt.</p>");
  }
  delen.push(`<p>Bron: <a class="wire-bron-link" href="${escapeHtml(veiligeUrl(r.url))}" target="_blank" rel="noopener">${escapeHtml(r.bronNaam || "bron")} ↗</a></p>`);
  if (r.ookGemeld && r.ookGemeld.length) {
    const links = r.ookGemeld
      .map((o) => `<a class="wire-bron-link" href="${escapeHtml(veiligeUrl(o.url))}" target="_blank" rel="noopener">${escapeHtml(o.bronNaam || "bron")} ↗</a>`)
      .join(", ");
    delen.push(`<p>Ook gemeld door: ${links}</p>`);
  }
  return delen.join("");
}

// Chips onder de meta-regel: wie meldt het nog meer, wat staat ervan in de
// agenda en welke berichten gaan over dezelfde zaak.
function renderWireChips(r) {
  const chips = [];
  if (r.ookGemeld && r.ookGemeld.length) {
    const namen = r.ookGemeld.map((o) => o.bronNaam).filter(Boolean);
    chips.push(`<span class="chip chip-ook" title="Dezelfde gebeurtenis, andere bron">ook: ${escapeHtml(namen.slice(0, 2).join(", "))}${namen.length > 2 ? ` +${namen.length - 2}` : ""}</span>`);
  }
  for (const id of (r.agendaIds || []).slice(0, 2)) {
    const item = state.agendaPerId.get(id);
    if (!item) continue;
    const termijn = item.afkomst === "termijn";
    const tekst = termijn
      ? `${item.kop.split(":")[0]} ${datumKort(item.startDag)}`
      : `Agenda: ${datumKort(item.startDag)}${item.heeftTijd ? ` ${tijdVan(item.start)}` : ""}`;
    chips.push(`<button type="button" class="chip chip-agenda" data-actie="naar-agenda" data-dag="${escapeHtml(item.startDag)}">${escapeHtml(tekst)}</button>`);
  }
  for (const id of (r.gerelateerd || []).slice(0, 3)) {
    const ander = state.perGroep.get(id);
    if (!ander || ander.groepId === r.groepId) continue;
    const kort = String(ander.kop || "").length > 34 ? `${String(ander.kop).slice(0, 33)}…` : String(ander.kop || "");
    chips.push(`<button type="button" class="chip chip-bericht" data-actie="open-bericht" data-id="${escapeHtml(ander.id)}" title="Zelfde zaak: ${escapeHtml(ander.kop || "")}">zie ook: ${escapeHtml(kort)}</button>`);
  }
  return chips.length ? `<div class="wire-chips">${chips.join("")}</div>` : "";
}

function renderWireItem(r, kolomCode) {
  const dag = dagVan(r.tijd);
  const tijd = r.heeftTijd ? tijdVan(r.tijd) : "–";
  const woorden = r.woorden == null ? "–" : `${r.woorden}${r.afgekapt ? "+" : ""}`;
  const prio = Number.isInteger(r.prio) ? r.prio : 3;
  const detailId = `detail-${kolomCode}-${r.id}`;
  const heeftAlert = r.alert && state.alertModus === "aan" && new Date(r.alert.tot).getTime() > Date.now();
  const isNieuw = state.bezoekStart && String(r.eerstGezienOp) > state.bezoekStart;
  // In de totaalkolom staat de tag erbij; in een tagkolom is dat overbodig.
  const tag = kolomCode === "ALL" && r.rubriek ? `<div><dt>tag</dt><dd>${escapeHtml(r.rubriek)}</dd></div>` : "";
  return `
    <article class="wire-item prioriteit-${prio}${heeftAlert ? ` heeft-alert alert-${r.alert.niveau}` : ""}" data-id="${escapeHtml(r.id)}">
      <div class="title-row">
        <button type="button" class="wire-kop" aria-expanded="false" aria-controls="${escapeHtml(detailId)}">${isNieuw ? '<span class="nieuw-stip">nieuw</span> ' : ""}${escapeHtml(r.kop)}${r.versie > 1 ? ` <span class="versie-suffix">(${r.versie})</span>` : ""}</button>
      </div>
      <dl class="wire-meta">
        <div><dt>tijd</dt><dd>${tijd}</dd></div>
        <div><dt>${dag ? escapeHtml(dag.slice(0, 4)) : "datum"}</dt><dd>${dag ? `${escapeHtml(datumKort(dag))}.` : "–"}</dd></div>
        <div><dt>woorden</dt><dd>${woorden}</dd></div>
        <div><dt>versie</dt><dd>${r.versie || 1}</dd></div>
        <div><dt>prio</dt><dd><span class="prio-waarde prio-${prio}">${prio}</span></dd></div>
        ${tag}
      </dl>
      ${renderWireChips(r)}
      <div class="wire-detail" id="${escapeHtml(detailId)}" hidden>${renderWireDetail(r)}</div>
    </article>`;
}

// De lijst van één kolom. Apart, zodat zoeken alleen de lijst vervangt en het
// zoekveld zijn cursor houdt.
function kolomLijstHtml(code) {
  const { lijst, ouder, zoekt } = kolomBerichten(code);
  let html = lijst.map((r) => renderWireItem(r, code)).join("");
  if (!html) html = `<p class="agenda-leeg">${zoekt ? "Niets gevonden." : "Geen berichten in de laatste drie dagen."}</p>`;
  if (ouder > 0) {
    html += `<button type="button" class="oudere-knop" data-actie="oudere" data-kolom="${escapeHtml(code)}">Oudere berichten (${ouder})</button>`;
  }
  return html;
}

function renderWireKolom(code, naam) {
  const info = agendaVandaagInfo(code === "ALL" ? "" : code);
  const agendaTekst = info.aantal === 0
    ? "Geen agenda vandaag"
    : `Agenda vandaag: ${info.aantal}${info.bereik ? ` · ${info.bereik}` : ""}`;
  const zoekOpen = state.zoekOpen.has(code) || Boolean(state.zoek[code]);

  return `
    <section class="wire-kolom${code === state.mobileKolom ? " actief" : ""}" data-kolom="${escapeHtml(code)}" aria-label="${escapeHtml(naam)}">
      <div class="wire-kaart">
        <div class="wire-kolom-kop">
          <h2 class="column-title">${escapeHtml(naam)}</h2>
          <div class="kolom-acties">
            <button type="button" class="icoon-knop" data-actie="zoek-toggle" data-kolom="${escapeHtml(code)}" aria-label="Zoeken in ${escapeHtml(naam)}" aria-expanded="${zoekOpen}" title="Zoeken">${ZOEK_SVG}</button>
            <details class="kolom-menu">
              <summary class="icoon-knop" aria-label="Menu van ${escapeHtml(naam)}" title="Menu">${MENU_SVG}</summary>
              <div class="kolom-menu-lijst">
                <button type="button" data-actie="agenda-van-kolom" data-rubriek="${code === "ALL" ? "" : escapeHtml(code)}">${escapeHtml(agendaTekst)}</button>
                <button type="button" data-actie="kolom-verberg" data-kolom="${escapeHtml(code)}">Kolom verbergen</button>
              </div>
            </details>
          </div>
        </div>
        <div class="wire-zoek-rij"${zoekOpen ? "" : " hidden"}>
          <input type="search" class="wire-zoek" data-actie="kolom-zoek" data-kolom="${escapeHtml(code)}" placeholder="Zoek" aria-label="Zoek in ${escapeHtml(naam)}" autocomplete="off" value="${escapeHtml(state.zoek[code] || "")}">
        </div>
        <div class="wire-lijst">${kolomLijstHtml(code)}</div>
      </div>
    </section>`;
}

function renderWire() {
  const container = document.getElementById("wire-kolommen");
  if (state.berichten.length === 0) {
    container.innerHTML = '<p class="leeg">De nieuwsdienst heeft nog geen berichten. Die verschijnen na de eerstvolgende run van de workflow.</p>';
    document.getElementById("kolom-tabs").innerHTML = "";
    document.getElementById("kolommen-opties").innerHTML = "";
    return;
  }
  renderKolommenKiezer();
  renderKolomTabs();
  container.innerHTML = getoondeKolommen().map((k) => renderWireKolom(k.code, k.naam)).join("");
}

// Opent een bericht in de stroom: zoekvelden wissen, tab tonen, kolom kiezen, scrollen.
function springNaarBericht(id) {
  state.zoek = {};
  state.oudere.add("ALL"); // het bericht kan ouder zijn dan drie dagen
  state.kolommenUit.delete("ALL");
  state.mobileKolom = "ALL";
  toonTab("nieuwsdienst");
  renderWire();

  let item = document.querySelector(`#wire-kolommen [data-kolom="ALL"] .wire-item[data-id="${id}"]`);
  if (!item) {
    // Het bericht kan achter een cluster zijn weggevallen: zoek het primaire bericht.
    const gezocht = state.berichten.find((r) => r.id === id);
    const alt = gezocht && state.zichtbaar.find((r) => r.groepId === gezocht.groepId || (gezocht.clusterId && r.clusterId === gezocht.clusterId));
    if (alt) item = document.querySelector(`#wire-kolommen [data-kolom="ALL"] .wire-item[data-id="${alt.id}"]`);
  }
  if (!item) return;
  const kop = item.querySelector(".wire-kop");
  kop.setAttribute("aria-expanded", "true");
  const detail = document.getElementById(kop.getAttribute("aria-controls"));
  if (detail) detail.hidden = false;
  if (item.scrollIntoView) item.scrollIntoView({ block: "center" });
  kop.focus();
}

function koppelWire() {
  const timers = {};
  document.addEventListener("input", (e) => {
    const veld = e.target.closest ? e.target.closest('[data-actie="kolom-zoek"]') : null;
    if (!veld) return;
    const code = veld.dataset.kolom;
    state.zoek[code] = veld.value;
    clearTimeout(timers[code]);
    timers[code] = setTimeout(() => {
      const kolom = [...document.querySelectorAll(".wire-kolom")].find((k) => k.dataset.kolom === code);
      const lijst = kolom && kolom.querySelector(".wire-lijst");
      if (lijst) lijst.innerHTML = kolomLijstHtml(code);
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

function dagNaarDate(dag) {
  return new Date(`${dag}T12:00:00Z`);
}

function zetAgenda(items) {
  state.agenda = Array.isArray(items) ? items : [];
  state.agendaPerId = new Map(state.agenda.map((i) => [i.id, i]));
}

function agendaTijdLabel(item) {
  if (item.doorlopend) {
    const begin = item.heeftTijd ? `${datumKort(item.startDag)} ${tijdVan(item.start)}` : datumKort(item.startDag);
    let eind = datumKort(item.eindDag);
    if (item.eind) {
      const eindDag = dagVan(item.eind);
      eind = item.heeftTijd ? `${datumKort(eindDag)} ${tijdVan(item.eind)}` : datumKort(item.eindDag);
    }
    return `${begin} – ${eind}`;
  }
  if (!item.heeftTijd) return null;
  const circa = item.tijdBron === "tekst" ? "±" : "";
  return `${circa}${tijdVan(item.start)}${item.eind ? ` – ${tijdVan(item.eind)}` : ""}`;
}

// Een klein vierkantje "T" dat het bericht erover opent; titel en aria-label
// zeggen wat het is.
function berichtKnop(groepId, titel, tekst = "T") {
  const record = groepId ? state.perGroep.get(groepId) : null;
  if (!record) return "";
  return `<button type="button" class="chip chip-bericht chip-t" data-actie="open-bericht" data-id="${escapeHtml(record.id)}" title="${escapeHtml(titel)}: ${escapeHtml(record.kop || "")}" aria-label="${escapeHtml(titel)}: ${escapeHtml(record.kop || "")}">${escapeHtml(tekst)}</button>`;
}

function renderAgendaItem(item) {
  const label = agendaTijdLabel(item);
  const tijdHtml = label
    ? `<div class="agenda-tijd">${KLOK_SVG}<span>${escapeHtml(label)}</span>${item.doorlopend ? '<span class="doorlopend-label">Doorlopend</span>' : ""}</div>`
    : '<div class="agenda-tijd onbekend">tijd onbekend</div>';
  const status = item.status ? `<span class="agenda-status">(${escapeHtml(item.status)})</span> ` : "";
  const meta = [item.bronNaam, item.plaats].filter(Boolean).join(" · ");

  const chips = [];
  const gefilterd = item.zichtbaar === false || item.inAfwachting;
  if (item.inAfwachting) chips.push('<span class="chip chip-grijs" title="Wacht op de detailpagina voor het filter">in afwachting</span>');
  else if (item.zichtbaar === false) chips.push('<span class="chip chip-grijs" title="Valt af door het agendafilter">gefilterd</span>');
  const regel = item.relevantie && item.relevantie.regel;
  if (regel === "eerste-keer") chips.push('<span class="chip chip-regel" title="Eerste keer volgens de bron">eerste keer</span>');
  if (regel === "jubileum") chips.push('<span class="chip chip-regel" title="Jubileum of herdenking volgens de bron">jubileum</span>');
  // Het bericht erover (T), eventueel meer berichten over dezelfde zaak, en de uitkomst.
  const titel = item.afkomst === "termijn" ? "Termijn uit bericht" : item.afkomst === "bericht" ? "Agendapunt uit bericht" : "Bericht over dit agendapunt";
  const eigen = berichtKnop(item.berichtId, titel);
  if (eigen) chips.push(eigen);
  else if (item.afkomst === "bericht") chips.push('<span class="chip chip-bericht" title="Agendapunt uit een bericht">uit bericht</span>');
  else if (item.afkomst === "termijn") chips.push('<span class="chip chip-bericht" title="Termijn uit een bericht">termijn</span>');
  for (const id of (item.meerBerichten || []).slice(0, 3)) chips.push(berichtKnop(id, "Ander bericht over dit agendapunt"));
  const uitkomst = berichtKnop(item.uitkomstId, "Uitkomst", "uitkomst ↗");
  if (uitkomst) chips.push(uitkomst);

  return `
    <article class="agenda-item${gefilterd ? " gefilterd" : ""}">
      ${tijdHtml}
      <p class="agenda-kop">${status}<a href="${escapeHtml(veiligeUrl(item.url))}" target="_blank" rel="noopener">${escapeHtml(item.kop)}</a></p>
      ${meta ? `<p class="agenda-meta">${escapeHtml(meta)}</p>` : ""}
      ${chips.filter(Boolean).length ? `<div class="wire-chips">${chips.filter(Boolean).join("")}</div>` : ""}
    </article>`;
}

function agendaSleutel(item, dag) {
  if (!item.heeftTijd) return -1;
  if (item.startDag < dag) return 0;
  return minutenVan(item.start);
}

function renderAgenda() {
  const container = document.getElementById("agenda-week");
  const vandaag = vandaagDag();
  const maandag = maandagVan(dagPlus(vandaag, state.agendaOffset * 7));
  const dagen = Array.from({ length: 7 }, (_, i) => dagPlus(maandag, i));
  const rubriek = state.agendaRubriek;
  const toonAlles = state.agendaToonAlles;

  document.getElementById("agenda-weeklabel").textContent =
    `Week ${isoWeekNummer(maandag)} · ${datumKort(maandag)} – ${datumKort(dagen[6])}`;

  const namen = Object.fromEntries(state.rubrieken.map((r) => [r.code, r.naam]));
  const filterKnop = document.getElementById("agenda-filter");
  filterKnop.hidden = !rubriek;
  filterKnop.textContent = rubriek ? `${namen[rubriek] || rubriek} ×` : "";
  filterKnop.title = "Toon alle rubrieken";

  if (state.agenda.length === 0) {
    document.getElementById("agenda-alles").hidden = true;
    container.innerHTML = '<p class="leeg">De agenda is nog leeg. Die vult zich na de eerstvolgende run van de workflow.</p>';
    return;
  }

  const items = state.agenda.filter((i) => !rubriek || i.rubriek === rubriek);
  const verborgen = items.filter((i) => i.startDag <= dagen[6] && i.eindDag >= dagen[0] && !agendaItemZichtbaar(i, false)).length;
  const allesKnop = document.getElementById("agenda-alles");
  allesKnop.hidden = verborgen === 0 && !toonAlles;
  allesKnop.textContent = toonAlles ? "alleen relevant" : `+${verborgen} gefilterd`;
  allesKnop.title = toonAlles
    ? "Verberg wat het agendafilter wegliet"
    : "Toon ook wat het agendafilter wegliet (evenementen die niet voor het eerst plaatsvinden)";

  const perDag = dagen.map((dag) =>
    items
      .filter((i) => i.startDag <= dag && dag <= i.eindDag && agendaItemZichtbaar(i, toonAlles))
      .sort((a, b) => agendaSleutel(a, dag) - agendaSleutel(b, dag) || a.kop.localeCompare(b.kop, "nl"))
  );

  container.innerHTML = dagen
    .map(
      (dag, i) => `
      <section class="agenda-dag${dag === vandaag ? " vandaag" : ""}" data-dag="${dag}" aria-label="${escapeHtml(dagMetWeekdag(dag))}">
        <h2 class="agenda-dag-kop">${escapeHtml(dagMetWeekdag(dag))}</h2>
        <div class="wire-lijst">${perDag[i].length ? perDag[i].map(renderAgendaItem).join("") : '<p class="agenda-leeg">Niets gepland.</p>'}</div>
      </section>`
    )
    .join("");
}

function scrollNaarAgendaDag() {
  if (!state.agendaDag) return;
  const dag = [...document.querySelectorAll("#agenda-week .agenda-dag")].find((k) => k.dataset.dag === state.agendaDag);
  state.agendaDag = null;
  if (dag && dag.scrollIntoView) dag.scrollIntoView({ block: "nearest", inline: "start" });
}

function springNaarAgenda(dag) {
  const verschil = Math.round((dagNaarDate(maandagVan(dag)) - dagNaarDate(maandagVan(vandaagDag()))) / (7 * 86400000));
  state.agendaOffset = verschil;
  state.agendaDag = dag;
  state.agendaRubriek = "";
  renderAgenda();
  toonTab("agenda");
  scrollNaarAgendaDag();
}

function koppelAgenda() {
  const verander = (offset) => {
    state.agendaOffset = offset;
    renderAgenda();
    schrijfHash();
  };
  document.getElementById("agenda-vorige").addEventListener("click", () => verander(state.agendaOffset - 1));
  document.getElementById("agenda-volgende").addEventListener("click", () => verander(state.agendaOffset + 1));
  document.getElementById("agenda-vandaag").addEventListener("click", () => verander(0));
  document.getElementById("agenda-filter").addEventListener("click", () => {
    state.agendaRubriek = "";
    renderAgenda();
    schrijfHash();
  });
  document.getElementById("agenda-alles").addEventListener("click", () => {
    state.agendaToonAlles = !state.agendaToonAlles;
    renderAgenda();
    schrijfHash();
  });
}

// ---------------------------------------------------------------------------
// Statusregel bovenaan
// ---------------------------------------------------------------------------

function duurTekst(minuten) {
  if (minuten < 60) return `${minuten} min`;
  return `${Math.floor(minuten / 60)} uur ${minuten % 60} min`;
}

function renderStatusregel() {
  const el = document.getElementById("laatste-update");
  if (!el) return;
  const delen = [];
  let verouderd = false;

  const stempel = (state.status && state.status.gegenereerdOp) || state.berichtenGegenereerdOp;
  if (stempel) {
    const minuten = Math.max(0, Math.round((Date.now() - new Date(stempel).getTime()) / 60000));
    delen.push(`Nieuwsdienst bijgewerkt: ${formatteerDatum(stempel)}`);
    delen.push(`${state.zichtbaar.length} berichten`);
    if (minuten > VEROUDERD_MINUTEN) {
      verouderd = true;
      delen.push(`⚠ de stroom is ${duurTekst(minuten)} oud: de laatste ZANP-run is mislukt of vertraagd`);
    }
  }
  if (state.status) {
    const zonderRubriek = Array.isArray(state.status.bronnenZonderRubriek) ? state.status.bronnenZonderRubriek.length : 0;
    if (zonderRubriek > 0) {
      delen.push(`${zonderRubriek} ${zonderRubriek === 1 ? "bron heeft" : "bronnen hebben"} nog geen rubriek-instelling`);
    }
    const bronnen = state.status.bronnen && typeof state.status.bronnen === "object" ? Object.values(state.status.bronnen) : [];
    const leeg = bronnen.filter((b) => b && Number(b.opeenvolgendLeeg) >= 3).length;
    if (leeg > 0) delen.push(`${leeg} ${leeg === 1 ? "bron levert" : "bronnen leverden"} drie runs achter elkaar niets op`);
  }
  el.textContent = delen.join(" · ");
  el.classList.toggle("verouderd", verouderd);
}

// ---------------------------------------------------------------------------
// Pitches (ongewijzigd, nu een eigen tab)
// ---------------------------------------------------------------------------

function scoreBand(score) {
  if (score >= 18) return "hoog";
  if (score >= 10) return "middel";
  return "laag";
}

function renderPitches(data) {
  const container = document.getElementById("pitches-lijst");
  const updateEl = document.getElementById("pitch-update");

  if (updateEl && data.gegenereerdOp) {
    const versie = data.promptVersie ? ` · prompt ${data.promptVersie}` : "";
    updateEl.textContent = `Laatst bijgewerkt: ${formatteerDatum(data.gegenereerdOp)} · ${data.aantalBerichtenTotaal ?? "?"} berichten verwerkt vandaag${versie}`;
  }

  if (!data.topPitches || data.topPitches.length === 0) {
    container.innerHTML = '<p class="leeg">Nog geen pitches vandaag — kom later terug of bekijk de volledige lijsten hieronder.</p>';
    return;
  }

  container.innerHTML = data.topPitches.map(renderPitchKaart).join("");
}

function renderPitchKaart(bericht) {
  const beoordeling = bericht.aiBeoordeling || {};
  const score = typeof beoordeling.score === "number" ? beoordeling.score : null;
  const band = score !== null ? scoreBand(score) : null;

  // Invalshoek is in de nieuwe pitch een string; in oude data kan het een
  // object { tekst, citaat } zijn.
  const invalshoekTekst = beoordeling.invalshoek
    ? (typeof beoordeling.invalshoek === "string" ? beoordeling.invalshoek : beoordeling.invalshoek.tekst)
    : null;

  const vraag = beoordeling.vraag || beoordeling.centraleVraag || null;

  return `
    <article class="pitch-kaart">
      <span class="badge ${escapeHtml(bericht.categorie || "lokaal")}">${escapeHtml(bericht.categorie || "lokaal")}</span>
      ${score !== null ? `<span class="badge pitch-score pitch-score-${band}" title="Codescore ${score} (agenda-filter)">score ${score} · ${band}</span>` : ""}
      <h3><a href="${escapeHtml(veiligeUrl(bericht.url))}" target="_blank" rel="noopener">${escapeHtml(beoordeling.werktitel || bericht.titel)}</a></h3>
      <div class="bericht-meta">${escapeHtml(bericht.bronNaam || "")} · ${formatteerDatum(bericht.gepubliceerdOp)}</div>
      ${beoordeling.samenvatting ? `<p class="pitch-samenvatting">${escapeHtml(beoordeling.samenvatting)}</p>` : ""}
      ${invalshoekTekst ? `<p class="invalshoek"><strong>Invalshoek:</strong> ${escapeHtml(invalshoekTekst)}</p>` : ""}
      ${vraag ? `<p class="researchvraag"><strong>Vraag:</strong> ${escapeHtml(vraag)}</p>` : ""}
      ${beoordeling.onderbouwing ? `<p class="onderbouwing"><em>${escapeHtml(beoordeling.onderbouwing)}</em></p>` : ""}
    </article>
  `;
}

function renderFeed(items) {
  const container = document.getElementById("feed-lijst");
  if (!items || items.length === 0) {
    container.innerHTML = '<p class="leeg">Nog geen berichten in de feed.</p>';
    return;
  }
  container.innerHTML = items.map(renderFeedItem).join("");
}

function escapeVoorCssUrl(url) {
  return String(url)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\)/g, "\\)")
    .replace(/\(/g, "\\(")
    .replace(/\s/g, "\\ ")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
}

function renderFeedItem(item) {
  const heeftFoto = typeof item.foto === "string" && item.foto.length > 0;
  const veiligeFoto = heeftFoto ? escapeVoorCssUrl(item.foto) : "";
  const stijl = heeftFoto ? ` style="background-image: url('${escapeHtml(veiligeFoto)}')"` : "";
  const soort = item.soort === "agenda" ? "agenda" : "nieuws";
  const soortLabel = soort === "agenda" ? "agenda" : "nieuws";

  return `
    <article class="feed-item feed-${soort}">
      <div class="feed-foto${heeftFoto ? " heeft-foto" : ""}"${stijl} role="img" aria-label="${heeftFoto ? "afbeelding bij het bericht" : "geen afbeelding beschikbaar"}">
        ${heeftFoto ? "" : '<span class="geen-foto-tekst">geen foto beschikbaar</span>'}
      </div>
      <div class="feed-tekst">
        <div class="feed-meta">
          <span class="feed-soort feed-soort-${soort}">${soortLabel}</span>
          <span class="feed-bron">${escapeHtml(item.bronNaam || "")}</span>
          <span class="feed-datum">${formatteerDatum(item.gepubliceerdOp)}</span>
        </div>
        <h3 class="feed-titel"><a href="${escapeHtml(veiligeUrl(item.url))}" target="_blank" rel="noopener">${escapeHtml(item.titel || "")}</a></h3>
        ${item.samenvatting ? `<p class="feed-samenvatting">${escapeHtml(item.samenvatting)}</p>` : ""}
      </div>
    </article>
  `;
}

function renderBerichtenLijst(containerId, berichten) {
  const container = document.getElementById(containerId);
  if (!berichten || berichten.length === 0) {
    container.innerHTML = '<p class="leeg">Geen berichten gevonden voor vandaag.</p>';
    return;
  }
  container.innerHTML = berichten.map(renderBerichtRij).join("");
}

function renderBerichtRij(bericht) {
  const beoordeling = bericht.aiBeoordeling || {};
  const score = typeof beoordeling.score === "number" ? beoordeling.score : null;
  const scoreTekst = score !== null ? `score ${score}` : "";
  return `
    <div class="bericht-rij">
      <span class="bericht-score">${escapeHtml(scoreTekst)}</span>
      <a href="${escapeHtml(veiligeUrl(bericht.url))}" target="_blank" rel="noopener">${escapeHtml(bericht.titel || "")}</a>
      <span class="bericht-meta">${escapeHtml(bericht.bronNaam || "")}</span>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Klikken, verversen, opstarten
// ---------------------------------------------------------------------------

function verbergLandelijk() {
  const sectie = document.getElementById("landelijk-sectie");
  if (sectie) sectie.style.display = "none";
}

function koppelKlikken() {
  document.addEventListener("click", (e) => {
    // Een open kolommenu sluit bij een klik ernaast.
    document.querySelectorAll(".kolom-menu[open]").forEach((m) => {
      if (!m.contains(e.target)) m.removeAttribute("open");
    });
    const kop = e.target.closest(".wire-kop");
    if (kop) {
      const open = kop.getAttribute("aria-expanded") === "true";
      kop.setAttribute("aria-expanded", open ? "false" : "true");
      const detail = document.getElementById(kop.getAttribute("aria-controls"));
      if (detail) detail.hidden = open;
      return;
    }
    const el = e.target.closest("[data-actie]");
    if (!el || el.tagName === "INPUT") return;
    switch (el.dataset.actie) {
      case "open-bericht":
        springNaarBericht(el.dataset.id);
        break;
      case "sluit-alert": {
        state.weggeklikt.add(el.dataset.sleutel);
        bewaarOpslag("zanp-alerts-weg", [...state.weggeklikt].slice(-200));
        renderAlertBalk();
        break;
      }
      case "naar-agenda":
        springNaarAgenda(el.dataset.dag);
        schrijfHash();
        break;
      case "agenda-van-kolom": {
        state.agendaOffset = 0;
        state.agendaDag = null;
        const code = el.dataset.rubriek || "";
        // Alleen filteren op een rubriek die in de agenda voorkomt.
        state.agendaRubriek = state.agenda.some((i) => i.rubriek === code) ? code : "";
        renderAgenda();
        toonTab("agenda");
        break;
      }
      case "oudere":
        state.oudere.add(el.dataset.kolom);
        renderWire();
        break;
      case "zoek-toggle": {
        const code = el.dataset.kolom;
        const kolom = [...document.querySelectorAll(".wire-kolom")].find((k) => k.dataset.kolom === code);
        const rij = kolom && kolom.querySelector(".wire-zoek-rij");
        if (!rij) break;
        const open = rij.hidden;
        rij.hidden = !open;
        el.setAttribute("aria-expanded", String(open));
        if (open) {
          state.zoekOpen.add(code);
          const veld = rij.querySelector(".wire-zoek");
          if (veld) veld.focus();
        } else {
          state.zoekOpen.delete(code);
          state.zoek[code] = "";
          const veld = rij.querySelector(".wire-zoek");
          if (veld) veld.value = "";
          const lijst = kolom.querySelector(".wire-lijst");
          if (lijst) lijst.innerHTML = kolomLijstHtml(code);
        }
        break;
      }
      case "kolom-verberg":
        state.kolommenUit.add(el.dataset.kolom);
        bewaarOpslag("zanp-kolommen-uit", [...state.kolommenUit]);
        renderWire();
        break;
      case "kolom-tab":
        state.mobileKolom = el.dataset.kolom;
        renderWire();
        break;
      default:
    }
  });

  document.addEventListener("change", (e) => {
    const box = e.target.closest('[data-actie="kolom-aan"]');
    if (!box) return;
    if (box.checked) state.kolommenUit.delete(box.dataset.kolom);
    else state.kolommenUit.add(box.dataset.kolom);
    bewaarOpslag("zanp-kolommen-uit", [...state.kolommenUit]);
    renderWire();
  });
}

// Bij een verversing mogen geopende berichten en scrollposities niet verdwijnen.
function bewaarUiStaat() {
  const open = [...document.querySelectorAll(".wire-kop")]
    .filter((k) => k.getAttribute("aria-expanded") === "true")
    .map((k) => k.getAttribute("aria-controls"));
  const scroll = {};
  document.querySelectorAll(".wire-kolom").forEach((k) => {
    const lijst = k.querySelector(".wire-lijst");
    if (lijst) scroll[k.dataset.kolom] = lijst.scrollTop;
  });
  const week = document.getElementById("agenda-week");
  const actief = document.activeElement;
  const focus = actief && actief.dataset && actief.dataset.actie === "kolom-zoek"
    ? { kolom: actief.dataset.kolom, positie: actief.selectionStart }
    : null;
  const kolommen = document.getElementById("wire-kolommen");
  return { open, scroll, agendaScroll: week ? week.scrollLeft : 0, wireScroll: kolommen ? kolommen.scrollLeft : 0, focus };
}

function herstelUiStaat(staat) {
  const open = new Set(staat.open);
  document.querySelectorAll(".wire-kop").forEach((k) => {
    if (!open.has(k.getAttribute("aria-controls"))) return;
    k.setAttribute("aria-expanded", "true");
    const detail = document.getElementById(k.getAttribute("aria-controls"));
    if (detail) detail.hidden = false;
  });
  document.querySelectorAll(".wire-kolom").forEach((k) => {
    const lijst = k.querySelector(".wire-lijst");
    if (lijst && staat.scroll[k.dataset.kolom] !== undefined) lijst.scrollTop = staat.scroll[k.dataset.kolom];
  });
  const week = document.getElementById("agenda-week");
  if (week) week.scrollLeft = staat.agendaScroll;
  const kolommen = document.getElementById("wire-kolommen");
  if (kolommen) kolommen.scrollLeft = staat.wireScroll || 0;
  if (staat.focus) {
    const veld = [...document.querySelectorAll(".wire-zoek")].find((v) => v.dataset.kolom === staat.focus.kolom);
    if (veld) {
      veld.focus();
      if (typeof staat.focus.positie === "number") veld.setSelectionRange(staat.focus.positie, staat.focus.positie);
    }
  }
}

function renderAlles() {
  renderAlertBalk();
  renderWire();
  renderAgenda();
  renderStatusregel();
}

let laatsteVerversing = Date.now();
let verversBezig = false;

// Haalt de ZANP-bestanden opnieuw op. Stil: een mislukte poging laat de
// huidige weergave staan en probeert het bij de volgende ronde opnieuw.
async function ververs() {
  if (verversBezig) return;
  verversBezig = true;
  try {
    const [berichten, agenda, status] = await Promise.allSettled([
      laadJson("data/berichten.json"),
      laadJson("data/agenda.json"),
      laadJson("data/zanp-status.json"),
    ]);
    const staat = bewaarUiStaat();
    let veranderd = false;
    if (berichten.status === "fulfilled") {
      zetBerichten(berichten.value);
      veranderd = true;
    }
    if (agenda.status === "fulfilled") {
      zetAgenda(agenda.value && agenda.value.items);
      veranderd = true;
    }
    if (status.status === "fulfilled") state.status = status.value;
    if (veranderd) {
      renderAlles();
      herstelUiStaat(staat);
    }
    laatsteVerversing = Date.now();
  } finally {
    verversBezig = false;
  }
}

function koppelVerversen() {
  setInterval(() => {
    if (document.visibilityState === "visible") ververs();
  }, VERVERS_MS);
  // Statusregel en alerts verlopen ook zonder nieuwe data.
  setInterval(() => {
    renderStatusregel();
    renderAlertBalk();
  }, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - laatsteVerversing > 2 * 60 * 1000) ververs();
    } else {
      bewaarOpslag("zanp-laatst-bezocht", new Date().toISOString());
    }
  });
  window.addEventListener("pagehide", () => bewaarOpslag("zanp-laatst-bezocht", new Date().toISOString()));
}

async function initialiseer() {
  koppelTabs();
  koppelWire();
  koppelAgenda();
  koppelKlikken();

  // Alles tegelijk ophalen; één ontbrekend bestand mag de rest niet blokkeren.
  const [berichten, agenda, status, pitches, feed, lokaal, landelijk] = await Promise.allSettled([
    laadJson("data/berichten.json"),
    laadJson("data/agenda.json"),
    laadJson("data/zanp-status.json"),
    laadJson("data/pitches.json"),
    laadJson("data/feed.json"),
    laadJson("data/nieuws-lokaal.json"),
    laadJson("data/nieuws-landelijk.json"),
  ]);

  if (berichten.status === "fulfilled") zetBerichten(berichten.value);
  if (agenda.status === "fulfilled") zetAgenda(agenda.value && agenda.value.items);
  if (status.status === "fulfilled") state.status = status.value;

  if (berichten.status === "rejected") {
    document.getElementById("wire-kolommen").innerHTML = nogGeenDataHtml(
      berichten.reason,
      "De nieuwsdienst heeft nog geen berichten. Die verschijnen na de eerstvolgende run van de workflow."
    );
  } else {
    renderWire();
  }
  renderAlertBalk();

  if (agenda.status === "rejected") {
    document.getElementById("agenda-week").innerHTML = nogGeenDataHtml(
      agenda.reason,
      "De agenda is nog leeg. Die vult zich na de eerstvolgende run van de workflow."
    );
  } else {
    renderAgenda();
  }
  renderStatusregel();

  if (pitches.status === "fulfilled") renderPitches(pitches.value);
  else document.getElementById("pitches-lijst").innerHTML = foutmeldingHtml(pitches.reason, "Pitches");

  if (feed.status === "fulfilled") renderFeed(feed.value);
  else document.getElementById("feed-lijst").innerHTML = foutmeldingHtml(feed.reason, "Feed");

  if (lokaal.status === "fulfilled") renderBerichtenLijst("lokaal-lijst", lokaal.value);
  else document.getElementById("lokaal-lijst").innerHTML = foutmeldingHtml(lokaal.reason, "Lokaal nieuws");

  if (landelijk.status === "fulfilled" && Array.isArray(landelijk.value) && landelijk.value.length > 0) {
    renderBerichtenLijst("landelijk-lijst", landelijk.value);
  } else {
    verbergLandelijk();
  }

  koppelVerversen();
}

initialiseer();
