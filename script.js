// script.js — front-end logica
//
// Leest vier statische JSON-bestanden die de GitHub Actions-workflow elke
// avond ververst: data/pitches.json, data/feed.json, data/nieuws-lokaal.json
// en data/nieuws-landelijk.json.
//
// Sinds de "pitch-en-filter-uit-elkaar"-ronde (2026-10-22):
//  - Pitch-kaart toont de vier velden van de nieuwe pitch: werktitel (als
//    titel), samenvatting (pitch-samenvatting), invalshoek, vraag.
//  - Score-badge verschijnt alleen nog als aiBeoordeling.score bestaat
//    (agenda; nieuws heeft geen score meer).
//  - Oude velden (kern, feiten, uit te zoeken, bellijst, genre, afnemer,
//    eerste check) worden niet meer gerenderd.
//  - Top-pitches komen gesorteerd op datum binnen (nieuwste eerst); de
//    front-end sorteert niet opnieuw.

async function laadJson(pad) {
  const response = await fetch(pad, { cache: "no-store" });
  if (!response.ok) throw new Error(`Kon ${pad} niet laden (HTTP ${response.status})`);
  return response.json();
}

function formatteerDatum(isoTekst) {
  if (!isoTekst) return "datum onbekend";
  const datum = new Date(isoTekst);
  if (isNaN(datum.getTime())) return "datum onbekend";

  const tijdInAmsterdam = datum.toLocaleTimeString("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const isMiddernacht = tijdInAmsterdam === "00:00";

  const opties = {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Amsterdam",
  };
  if (!isMiddernacht) {
    opties.hour = "2-digit";
    opties.minute = "2-digit";
  }
  return datum.toLocaleString("nl-NL", opties);
}

function scoreBand(score) {
  if (score >= 18) return "hoog";
  if (score >= 10) return "middel";
  return "laag";
}

function renderPitches(data) {
  const container = document.getElementById("pitches-lijst");
  const updateEl = document.getElementById("laatste-update");

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
      <h3><a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(beoordeling.werktitel || bericht.titel)}</a></h3>
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
  const score = typeof beoordeling.score === "number" ? beoordeling.score : null;
  const scoreTekst = score !== null ? `score ${score}` : "";
  return `
    <div class="bericht-rij">
      <span class="bericht-score">${escapeHtml(scoreTekst)}</span>
      <a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(bericht.titel || "")}</a>
      <span class="bericht-meta">${escapeHtml(bericht.bronNaam || "")}</span>
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
    document.getElementById("pitches-lijst").innerHTML = `<p class="foutmelding">Pitches konden niet geladen worden: ${escapeHtml(fout.message)}</p>`;
  }

  try {
    const feed = await laadJson("data/feed.json");
    renderFeed(feed);
  } catch (fout) {
    document.getElementById("feed-lijst").innerHTML = `<p class="foutmelding">Feed kon niet geladen worden: ${escapeHtml(fout.message)}</p>`;
  }

  try {
    const lokaal = await laadJson("data/nieuws-lokaal.json");
    renderBerichtenLijst("lokaal-lijst", lokaal);
  } catch (fout) {
    document.getElementById("lokaal-lijst").innerHTML = `<p class="foutmelding">Lokaal nieuws kon niet geladen worden: ${escapeHtml(fout.message)}</p>`;
  }

  try {
    const landelijk = await laadJson("data/nieuws-landelijk.json");
    if (Array.isArray(landelijk) && landelijk.length > 0) {
      renderBerichtenLijst("landelijk-lijst", landelijk);
    } else {
      const sectie = document.getElementById("landelijk-sectie");
      if (sectie) sectie.style.display = "none";
    }
  } catch {
    const sectie = document.getElementById("landelijk-sectie");
    if (sectie) sectie.style.display = "none";
  }
}

initialiseer();
