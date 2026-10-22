// script.js — front-end logica
//
// Leest vier statische JSON-bestanden die de GitHub Actions-workflow elke
// avond ververst: data/pitches.json, data/feed.json, data/nieuws-lokaal.json
// en data/nieuws-landelijk.json.
//
// Sinds de "gradatie-en-bewijs-zonder-labels"-ronde (2026-10-21):
//  - Geen prioriteit-badge meer; de codescore staat centraal.
//  - Pitch-kaart toont de nieuwe velden: kern, feiten, uit te zoeken,
//    bellijst met rollen, genre, afnemer.
//  - Bronnen als objecten (bellijst) worden gerenderd; oude pitches met
//    bronnen als strings blijven werken.
//  - Berichtenlijst toont de codescore in plaats van de stippen.

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

  // Nieuwe bellijst (objecten) of oude bronnen (strings).
  const bellijst = Array.isArray(beoordeling.bellijst) ? beoordeling.bellijst.filter((b) => b && typeof b === "object") : [];
  const oudeBronnen = Array.isArray(beoordeling.bronnen)
    ? beoordeling.bronnen.filter((b) => typeof b === "string" && b.trim())
    : [];

  // Invalshoek kan een string (oud) of een object { tekst, citaat } (nieuw) zijn.
  const invalshoekTekst = beoordeling.invalshoek
    ? (typeof beoordeling.invalshoek === "string" ? beoordeling.invalshoek : beoordeling.invalshoek.tekst)
    : null;

  const feiten = Array.isArray(beoordeling.feiten) ? beoordeling.feiten.filter((f) => f && (f.tekst || typeof f === "string")) : [];
  const uitTeZoeken = Array.isArray(beoordeling.uitTeZoeken) ? beoordeling.uitTeZoeken.filter((u) => typeof u === "string" && u.trim()) : [];

  return `
    <article class="pitch-kaart">
      <span class="badge ${escapeHtml(bericht.categorie || "lokaal")}">${escapeHtml(bericht.categorie || "lokaal")}</span>
      ${score !== null ? `<span class="badge pitch-score pitch-score-${band}" title="Codescore ${score} van de maximaal haalbare score">score ${score} · ${band}</span>` : ""}
      ${beoordeling.genre ? `<span class="badge pitch-genre">${escapeHtml(beoordeling.genre)}</span>` : ""}
      <h3><a href="${escapeHtml(bericht.url)}" target="_blank" rel="noopener">${escapeHtml(beoordeling.werktitel || bericht.titel)}</a></h3>
      <div class="bericht-meta">${escapeHtml(bericht.bronNaam || "")} · ${formatteerDatum(bericht.gepubliceerdOp)}</div>
      ${beoordeling.kern ? `<p class="pitch-kern">${escapeHtml(beoordeling.kern)}</p>` : ""}
      ${invalshoekTekst ? `<p class="invalshoek"><strong>Invalshoek:</strong> ${escapeHtml(invalshoekTekst)}</p>` : ""}
      ${beoordeling.centraleVraag ? `<p class="researchvraag"><strong>Centrale vraag:</strong> ${escapeHtml(beoordeling.centraleVraag)}</p>` : ""}
      ${feiten.length > 0 ? `<div class="pitch-feiten"><strong>Feiten:</strong><ul>${feiten.map((f) => `<li>${escapeHtml(typeof f === "string" ? f : f.tekst || "")}</li>`).join("")}</ul></div>` : ""}
      ${uitTeZoeken.length > 0 ? `<div class="pitch-uittezoeken"><strong>Uit te zoeken:</strong><ul>${uitTeZoeken.map((u) => `<li>${escapeHtml(u)}</li>`).join("")}</ul></div>` : ""}
      ${bellijst.length > 0 ? `<div class="pitch-bellijst"><strong>Bellijst:</strong><ul>${bellijst.map((b) => `<li><strong>${escapeHtml(b.rol || "bron")}:</strong> ${escapeHtml(b.naam || "nader te bepalen")}${b.waarom ? ` — ${escapeHtml(b.waarom)}` : ""}</li>`).join("")}</ul></div>` : ""}
      ${oudeBronnen.length > 0 ? `<p class="bronnen"><strong>Bronnen:</strong> ${oudeBronnen.map((b) => escapeHtml(b)).join(", ")}</p>` : ""}
      ${beoordeling.eersteCheck ? `<p class="pitch-eerstecheck"><strong>Eerste check:</strong> ${escapeHtml(beoordeling.eersteCheck)}</p>` : ""}
      ${beoordeling.afnemer ? `<p class="pitch-afnemer"><strong>Afnemer:</strong> ${escapeHtml(beoordeling.afnemer)}</p>` : ""}
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
