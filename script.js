// script.js — front-end logica
//
// Deze pagina leest vier statische JSON-bestanden die de GitHub Actions-
// workflow elke avond ververst: data/pitches.json, data/feed.json,
// data/nieuws-lokaal.json en data/nieuws-landelijk.json. Geen backend nodig —
// alles is een simpele fetch() naar bestanden in dezelfde repo.
//
// Sinds de nieuwe pitch-structuur (op basis van het Basisboek journalistiek
// schrijven) toont een pitch-kaart nu: invalshoek, researchvraag, bronnen en
// prioriteit. De oude velden (gevolgenVoor, gevolg, vervolgstappen) zijn
// vervangen.

async function laadJson(pad) {
  const response = await fetch(pad, { cache: "no-store" });
  if (!response.ok) throw new Error(`Kon ${pad} niet laden (HTTP ${response.status})`);
  return response.json();
}

function formatteerDatum(isoTekst) {
  if (!isoTekst) return "datum onbekend";
  const datum = new Date(isoTekst);
  if (isNaN(datum.getTime())) return "datum onbekend";
  return datum.toLocaleString("nl-NL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderPitches(data) {
  const container = document.getElementById("pitches-lijst");
  const updateEl = document.getElementById("laatste-update");

  if (updateEl && data.gegenereerdOp) {
    updateEl.textContent = `Laatst bijgewerkt: ${formatteerDatum(data.gegenereerdOp)} · ${data.aantalBerichtenTotaal ?? "?"} berichten verwerkt vandaag`;
  }

  if (!data.topPitches || data.topPitches.length === 0) {
    container.innerHTML = '<p class="leeg">Nog geen pitches vandaag — kom later terug of bekijk de volledige lijsten hieronder.</p>';
    return;
  }

  container.innerHTML = data.topPitches.map(renderPitchKaart).join("");
}

function renderPitchKaart(bericht) {
  const beoordeling = bericht.aiBeoordeling || {};
  const prioriteit = Number.isInteger(beoordeling.prioriteit) ? beoordeling.prioriteit : null;
  const bronnen = Array.isArray(beoordeling.bronnen) ? beoordeling.bronnen.filter((b) => typeof b === "string" && b.trim()) : [];

  return `
    <article class="pitch-kaart">
      <span class="badge ${bericht.categorie}">${bericht.categorie}</span>
      ${prioriteit !== null ? `<span class="badge prioriteit-badge">prioriteit ${prioriteit}/10</span>` : ""}
      <h3><a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel)}</a></h3>
      <div class="bericht-meta">${escapeHtml(bericht.bronNaam)} · ${formatteerDatum(bericht.gepubliceerdOp)}</div>
      ${beoordeling.invalshoek ? `<p class="invalshoek"><strong>Invalshoek:</strong> ${escapeHtml(beoordeling.invalshoek)}</p>` : ""}
      ${beoordeling.researchvraag ? `<p class="researchvraag"><strong>Researchvraag:</strong> ${escapeHtml(beoordeling.researchvraag)}</p>` : ""}
      ${bronnen.length > 0 ? `<p class="bronnen"><strong>Bronnen:</strong> ${bronnen.map((b) => escapeHtml(b)).join(", ")}</p>` : ""}
      ${beoordeling.onderbouwing ? `<p class="onderbouwing"><em>${escapeHtml(beoordeling.onderbouwing)}</em></p>` : ""}
    </article>
  `;
}

/**
 * De nieuwsfeed: alle binnengekomen berichten op datum, nieuwste eerst.
 * Elk item heeft een foto (of een grijs vlak), een titel en een stukje tekst.
 * Nieuws krijgt een rood accent, agenda/evenement een geel accent.
 */
function renderFeed(items) {
  const container = document.getElementById("feed-lijst");
  if (!items || items.length === 0) {
    container.innerHTML = '<p class="leeg">Nog geen berichten in de feed.</p>';
    return;
  }
  container.innerHTML = items.map(renderFeedItem).join("");
}

function renderFeedItem(item) {
  const heeftFoto = typeof item.foto === "string" && item.foto.length > 0;
  const veiligeFoto = heeftFoto ? item.foto.replace(/'/g, "%27").replace(/\)/g, "%29") : "";
  const stijl = heeftFoto ? ` style="background-image: url('${veiligeFoto}')"` : "";
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
        <h3 class="feed-titel"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.titel || "")}</a></h3>
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
  const oppakbaar = beoordeling.oppakbaar || beoordeling.lokaleInvalshoek || "";
  const stippen = oppakbaar === "ja" ? "●●" : oppakbaar === "twijfel" ? "●○" : "○○";
  return `
    <div class="bericht-rij">
      <span class="bericht-stip" title="${escapeHtml(oppakbaar)}">${stippen}</span>
      <a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel)}</a>
      <span class="bericht-meta">${escapeHtml(bericht.bronNaam)}</span>
    </div>
  `;
}

function escapeHtml(tekst) {
  const div = document.createElement("div");
  div.textContent = tekst ?? "";
  return div.innerHTML;
}

async function initialiseer() {
  try {
    const pitches = await laadJson("data/pitches.json");
    renderPitches(pitches);
  } catch (fout) {
    document.getElementById("pitches-lijst").innerHTML = `<p class="foutmelding">Pitches konden niet geladen worden: ${fout.message}</p>`;
  }

  try {
    const feed = await laadJson("data/feed.json");
    renderFeed(feed);
  } catch (fout) {
    document.getElementById("feed-lijst").innerHTML = `<p class="foutmelding">Feed kon niet geladen worden: ${fout.message}</p>`;
  }

  try {
    const lokaal = await laadJson("data/nieuws-lokaal.json");
    renderBerichtenLijst("lokaal-lijst", lokaal);
  } catch (fout) {
    document.getElementById("lokaal-lijst").innerHTML = `<p class="foutmelding">Lokaal nieuws kon niet geladen worden: ${fout.message}</p>`;
  }

  try {
    const landelijk = await laadJson("data/nieuws-landelijk.json");
    renderBerichtenLijst("landelijk-lijst", landelijk);
  } catch (fout) {
    document.getElementById("landelijk-lijst").innerHTML = `<p class="foutmelding">Landelijk nieuws kon niet geladen worden: ${fout.message}</p>`;
  }
}

initialiseer();
