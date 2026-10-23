// script.js — front-end logica
//
// Leest statische JSON-bestanden die de GitHub Actions-workflow elke nacht
// ververst:
//   data/berichten.json   de nieuwsstroom (ZANP)
//   data/agenda.json      de weekagenda (ZANP)
//   data/pitches.json, data/feed.json, data/nieuws-lokaal.json,
//   data/nieuws-landelijk.json   de pitchmachine (tab Pitches)
//   data/bron-gezondheid.json    alleen voor de statusregel bovenaan
//
// Sinds de ZANP-ronde (2026-10-23):
//  - Drie tabs: Nieuwsdienst (standaard), Agenda en Pitches. De pitchmachine
//    is ongewijzigd en staat nu in de derde tab.
//  - Nieuwsdienst: een kolom per rubriek plus een totaalkolom, naar het
//    voorbeeld van het ANP-dashboard. Elk bericht toont tijd, datum, woorden,
//    versie en prio. Klik op een kop voor tekst en bronlink.
//  - Agenda: weekweergave met tijdsbereik, ± bij tijden uit tekst,
//    statusprefix en een badge voor doorlopende evenementen.
//  - escapeHtml escapet nu ook aanhalingstekens (het werd in attributen
//    gebruikt) en alle links worden alleen http(s) toegelaten.

const TIJDZONE = "Europe/Amsterdam";
const TABS = ["nieuwsdienst", "agenda", "pitches"];

const state = {
  berichten: [],
  rubrieken: [],
  berichtenGegenereerdOp: null,
  agenda: [],
  agendaOffset: 0,
  gezondheid: null,
  bronnenZonderBerichten: 0,
};

const KLOK_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
  + '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// ---------------------------------------------------------------------------
// Algemene hulpfuncties
// ---------------------------------------------------------------------------

async function laadJson(pad) {
  const response = await fetch(pad, { cache: "no-store" });
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
// Tabs
// ---------------------------------------------------------------------------

function toonTab(naam, opties = {}) {
  const gekozen = TABS.includes(naam) ? naam : "nieuwsdienst";
  for (const tab of TABS) {
    const knop = document.getElementById(`tab-${tab}`);
    const paneel = document.getElementById(`paneel-${tab}`);
    const actief = tab === gekozen;
    knop.setAttribute("aria-selected", actief ? "true" : "false");
    knop.tabIndex = actief ? 0 : -1;
    paneel.hidden = !actief;
  }
  if (opties.schrijfHash !== false) {
    history.replaceState(null, "", `#${gekozen}`);
  }
}

function koppelTabs() {
  const knoppen = TABS.map((t) => document.getElementById(`tab-${t}`));
  knoppen.forEach((knop, index) => {
    knop.addEventListener("click", () => toonTab(knop.dataset.tab));
    knop.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const volgende = (index + (e.key === "ArrowRight" ? 1 : -1) + knoppen.length) % knoppen.length;
      toonTab(knoppen[volgende].dataset.tab);
      knoppen[volgende].focus();
    });
  });
  window.addEventListener("hashchange", () => toonTab(window.location.hash.slice(1), { schrijfHash: false }));
  toonTab(window.location.hash.slice(1), { schrijfHash: false });
}

// ---------------------------------------------------------------------------
// Nieuwsdienst
// ---------------------------------------------------------------------------

function leesWireFilters() {
  return {
    zoek: document.getElementById("wire-zoek").value.trim().toLowerCase(),
    maxPrio: Number(document.getElementById("wire-prio").value),
    periode: Number(document.getElementById("wire-periode").value),
    recent: document.getElementById("wire-recent").checked,
  };
}

function gefilterdeBerichten() {
  const { zoek, maxPrio, periode, recent } = leesWireFilters();
  const ondergrens = periode >= 999 ? null : dagPlus(vandaagDag(), -periode);
  return state.berichten.filter((r) => {
    if (r.prio > maxPrio) return false;
    if (recent && !(r.versie > 1)) return false;
    if (ondergrens && (dagVan(r.tijd) || "") < ondergrens) return false;
    if (zoek) {
      const hooi = `${r.kop} ${r.tekst || ""} ${r.bronNaam || ""}`.toLowerCase();
      if (!hooi.includes(zoek)) return false;
    }
    return true;
  });
}

// Agenda van vandaag voor de balk bovenaan een kolom.
function agendaVandaagInfo(rubriekCode) {
  const vandaag = vandaagDag();
  const items = state.agenda.filter(
    (i) =>
      i.startDag <= vandaag
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

function renderWireDetail(r) {
  const delen = [];
  if (r.tekst) delen.push(`<p>${escapeHtml(r.tekst)}</p>`);

  if (r.ai && r.tekst) {
    delen.push('<p><span class="wire-label ai">AI</span>Automatisch samengevat uit de bron. Controleer de feiten voor gebruik.</p>');
  } else if (r.soort === "signaal") {
    delen.push('<p><span class="wire-label signaal">Signaal</span>Artikel van een andere redactie: alleen de kop en een link. Lees het artikel via de bron.</p>');
  } else if (r.controle === "cijfers-afgekeurd") {
    delen.push('<p><span class="wire-label waarschuwing">Afgekeurd</span>De AI-samenvatting bevatte een getal dat niet in de bron staat. Dit is de originele kop.</p>');
  } else if (r.controle === "ai-onvoldoende-tekst") {
    delen.push("<p>De brontekst was te kort voor een samenvatting. Open de bron voor de details.</p>");
  } else if (r.seed) {
    delen.push("<p>Alleen de kop: dit bericht is bij de start van de nieuwsdienst overgenomen uit de feed.</p>");
  } else {
    delen.push("<p>Nog geen samenvatting beschikbaar.</p>");
  }

  if (r.versie > 1) {
    delen.push("<p>Nieuwe versie van een eerder bericht. De tijd is het moment waarop de wijziging is opgemerkt.</p>");
  }
  delen.push(`<p>Bron: <a class="wire-bron-link" href="${escapeHtml(veiligeUrl(r.url))}" target="_blank" rel="noopener">${escapeHtml(r.bronNaam || "bron")} ↗</a></p>`);
  return delen.join("");
}

function renderWireItem(r, kolomCode) {
  const dag = dagVan(r.tijd);
  const tijd = r.heeftTijd ? tijdVan(r.tijd) : "–";
  const woorden = r.woorden == null ? "–" : `${r.woorden}${r.afgekapt ? "+" : ""}`;
  const prio = Number.isInteger(r.prio) ? r.prio : 3;
  const detailId = `detail-${kolomCode}-${r.id}`;
  return `
    <article class="wire-item" data-id="${escapeHtml(r.id)}">
      <button type="button" class="wire-kop" aria-expanded="false" aria-controls="${escapeHtml(detailId)}">${escapeHtml(r.kop)}${r.versie > 1 ? ` <span class="versie-suffix">(${r.versie})</span>` : ""}</button>
      <dl class="wire-meta">
        <div><dt>tijd</dt><dd>${tijd}</dd></div>
        <div><dt>datum</dt><dd>${dag ? escapeHtml(datumKort(dag)) : "–"}</dd></div>
        <div><dt>woorden</dt><dd>${woorden}</dd></div>
        <div><dt>versie</dt><dd>${r.versie || 1}</dd></div>
        <div><dt>prio</dt><dd><span class="prio-waarde prio-${prio}">${prio}</span></dd></div>
      </dl>
      <div class="wire-detail" id="${escapeHtml(detailId)}" hidden>${renderWireDetail(r)}</div>
    </article>`;
}

function renderWireKolom(code, naam, berichten) {
  const info = agendaVandaagInfo(code === "ALL" ? "" : code);
  const agendaTekst = info.aantal === 0
    ? "Geen agenda vandaag"
    : `Agenda vandaag${info.bereik ? ` · ${info.bereik}` : ""}`;

  let lijst = "";
  let vorigeDag = null;
  for (const r of berichten) {
    const dag = dagVan(r.tijd);
    if (dag && dag !== vorigeDag) {
      lijst += `<h3 class="wire-dag">${escapeHtml(dagLabel(dag))}</h3>`;
      vorigeDag = dag;
    }
    lijst += renderWireItem(r, code);
  }
  if (!lijst) lijst = '<p class="agenda-leeg">Geen berichten voor deze filters.</p>';

  return `
    <section class="wire-kolom" aria-label="${escapeHtml(naam)}">
      <div class="wire-kolom-kop">
        <h2>${escapeHtml(naam)}</h2>
        <span class="wire-aantal">${berichten.length} ${berichten.length === 1 ? "bericht" : "berichten"}</span>
      </div>
      <button type="button" class="agenda-balk${info.aantal === 0 ? " leeg" : ""}" data-actie="agenda" data-rubriek="${code === "ALL" ? "" : escapeHtml(code)}">
        <span class="agenda-teller">${info.aantal}</span>
        <span>${escapeHtml(agendaTekst)}</span>
        <span class="agenda-balk-pijl" aria-hidden="true">→</span>
      </button>
      <div class="wire-lijst">${lijst}</div>
    </section>`;
}

function renderWire() {
  const container = document.getElementById("wire-kolommen");
  if (state.berichten.length === 0) {
    container.innerHTML = '<p class="leeg">De nieuwsdienst heeft nog geen berichten. Die verschijnen na de eerstvolgende run van de workflow.</p>';
    return;
  }

  const gefilterd = gefilterdeBerichten();
  const kolommen = [renderWireKolom("ALL", "ZANP totaal", gefilterd)];
  for (const rubriek of state.rubrieken) {
    const alle = state.berichten.some((r) => r.rubriek === rubriek.code);
    if (!alle) continue; // een lege rubriek tonen is ruis
    kolommen.push(renderWireKolom(rubriek.code, rubriek.naam, gefilterd.filter((r) => r.rubriek === rubriek.code)));
  }
  container.innerHTML = kolommen.join("");
}

function koppelWire() {
  let timer = null;
  const opnieuw = () => renderWire();
  document.getElementById("wire-zoek").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(opnieuw, 150);
  });
  for (const id of ["wire-prio", "wire-periode", "wire-recent"]) {
    document.getElementById(id).addEventListener("change", opnieuw);
  }

  document.getElementById("wire-kolommen").addEventListener("click", (e) => {
    const kop = e.target.closest(".wire-kop");
    if (kop) {
      const open = kop.getAttribute("aria-expanded") === "true";
      kop.setAttribute("aria-expanded", open ? "false" : "true");
      const detail = document.getElementById(kop.getAttribute("aria-controls"));
      if (detail) detail.hidden = open;
      return;
    }
    const balk = e.target.closest(".agenda-balk");
    if (balk) {
      state.agendaOffset = 0;
      document.getElementById("agenda-rubriek").value = balk.dataset.rubriek || "";
      renderAgenda();
      toonTab("agenda");
    }
  });
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

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

function renderAgendaItem(item) {
  const label = agendaTijdLabel(item);
  const tijdHtml = label
    ? `<div class="agenda-tijd">${KLOK_SVG}<span>${escapeHtml(label)}</span>${item.doorlopend ? '<span class="doorlopend-label">Doorlopend</span>' : ""}</div>`
    : '<div class="agenda-tijd onbekend">tijd onbekend</div>';
  const status = item.status ? `<span class="agenda-status">(${escapeHtml(item.status)})</span> ` : "";
  const meta = [item.bronNaam, item.plaats].filter(Boolean).join(" · ");
  return `
    <article class="agenda-item">
      ${tijdHtml}
      <p class="agenda-kop">${status}<a href="${escapeHtml(veiligeUrl(item.url))}" target="_blank" rel="noopener">${escapeHtml(item.kop)}</a></p>
      ${meta ? `<p class="agenda-meta">${escapeHtml(meta)}</p>` : ""}
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
  const rubriek = document.getElementById("agenda-rubriek").value;

  document.getElementById("agenda-weeklabel").textContent =
    `Week ${isoWeekNummer(maandag)} · ${datumKort(maandag)} – ${datumKort(dagen[6])} ${dagen[6].slice(0, 4)}`;

  if (state.agenda.length === 0) {
    container.innerHTML = '<p class="leeg">De agenda is nog leeg. Die vult zich na de eerstvolgende run van de workflow.</p>';
    return;
  }

  const items = state.agenda.filter((i) => !rubriek || i.rubriek === rubriek);
  container.innerHTML = dagen.map((dag) => {
    const vanDag = items
      .filter((i) => i.startDag <= dag && dag <= i.eindDag)
      .sort((a, b) => agendaSleutel(a, dag) - agendaSleutel(b, dag) || a.kop.localeCompare(b.kop, "nl"));
    return `
      <section class="agenda-dag${dag === vandaag ? " vandaag" : ""}" aria-label="${escapeHtml(dagMetWeekdag(dag))}">
        <h2 class="agenda-dag-kop">${escapeHtml(dagMetWeekdag(dag))}</h2>
        ${vanDag.length ? vanDag.map(renderAgendaItem).join("") : '<p class="agenda-leeg">Niets gepland.</p>'}
      </section>`;
  }).join("");
}

function vulAgendaRubrieken() {
  const select = document.getElementById("agenda-rubriek");
  const aanwezig = new Set(state.agenda.map((i) => i.rubriek));
  const namen = Object.fromEntries(state.rubrieken.map((r) => [r.code, r.naam]));
  const huidig = select.value;
  select.innerHTML = '<option value="">Alle rubrieken</option>'
    + [...aanwezig].map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(namen[code] || code)}</option>`).join("");
  select.value = aanwezig.has(huidig) ? huidig : "";
}

function koppelAgenda() {
  document.getElementById("agenda-vorige").addEventListener("click", () => { state.agendaOffset -= 1; renderAgenda(); });
  document.getElementById("agenda-volgende").addEventListener("click", () => { state.agendaOffset += 1; renderAgenda(); });
  document.getElementById("agenda-vandaag").addEventListener("click", () => { state.agendaOffset = 0; renderAgenda(); });
  document.getElementById("agenda-rubriek").addEventListener("change", renderAgenda);
}

// ---------------------------------------------------------------------------
// Statusregel bovenaan
// ---------------------------------------------------------------------------

function renderStatusregel() {
  const el = document.getElementById("laatste-update");
  if (!el) return;
  const delen = [];
  if (state.berichtenGegenereerdOp) {
    delen.push(`Nieuwsdienst bijgewerkt: ${formatteerDatum(state.berichtenGegenereerdOp)}`);
    delen.push(`${state.berichten.length} berichten`);
  }
  if (state.bronnenZonderBerichten > 0) {
    delen.push(`${state.bronnenZonderBerichten} ${state.bronnenZonderBerichten === 1 ? "bron levert" : "bronnen leveren"} al meerdere runs niets op`);
  }
  el.textContent = delen.join(" · ");
}

// bron-gezondheid.json: per bron een teller van opeenvolgende runs zonder berichten.
function telBronnenZonderBerichten(gezondheid) {
  if (!gezondheid || typeof gezondheid !== "object") return 0;
  const bronnen = gezondheid.bronnen && typeof gezondheid.bronnen === "object" ? gezondheid.bronnen : gezondheid;
  return Object.values(bronnen).filter((b) => b && typeof b === "object" && Number(b.opeenvolgendGeenBerichten) >= 2).length;
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
// Opstarten
// ---------------------------------------------------------------------------

function verbergLandelijk() {
  const sectie = document.getElementById("landelijk-sectie");
  if (sectie) sectie.style.display = "none";
}

async function initialiseer() {
  koppelTabs();
  koppelWire();
  koppelAgenda();

  // Alles tegelijk ophalen; één ontbrekend bestand mag de rest niet blokkeren.
  const [berichten, agenda, gezondheid, pitches, feed, lokaal, landelijk] = await Promise.allSettled([
    laadJson("data/berichten.json"),
    laadJson("data/agenda.json"),
    laadJson("data/bron-gezondheid.json"),
    laadJson("data/pitches.json"),
    laadJson("data/feed.json"),
    laadJson("data/nieuws-lokaal.json"),
    laadJson("data/nieuws-landelijk.json"),
  ]);

  if (berichten.status === "fulfilled") {
    const data = berichten.value || {};
    state.berichten = Array.isArray(data.berichten) ? data.berichten : [];
    state.rubrieken = Array.isArray(data.rubrieken) ? data.rubrieken : [];
    state.berichtenGegenereerdOp = data.gegenereerdOp || null;
  }
  if (agenda.status === "fulfilled") {
    state.agenda = Array.isArray(agenda.value && agenda.value.items) ? agenda.value.items : [];
  }
  if (gezondheid.status === "fulfilled") {
    state.bronnenZonderBerichten = telBronnenZonderBerichten(gezondheid.value);
  }

  if (berichten.status === "rejected") {
    document.getElementById("wire-kolommen").innerHTML = nogGeenDataHtml(
      berichten.reason,
      "De nieuwsdienst heeft nog geen berichten. Die verschijnen na de eerstvolgende run van de workflow."
    );
  } else {
    renderWire();
  }

  if (agenda.status === "rejected") {
    document.getElementById("agenda-week").innerHTML = nogGeenDataHtml(
      agenda.reason,
      "De agenda is nog leeg. Die vult zich na de eerstvolgende run van de workflow."
    );
  } else {
    vulAgendaRubrieken();
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
}

initialiseer();
