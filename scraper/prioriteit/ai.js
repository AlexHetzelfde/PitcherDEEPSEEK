// prioriteit/ai.js
//
// De AI-controle op het allerlaatst: een veto, nooit een voorstel.
//
// De berekening (score.js, beslis.js) bepaalt welke items rood zouden worden.
// Alleen die items gaan, in één of twee korte verzoeken, naar de AI met de
// vraag: klopt dit, of lijken de stukken alleen op elkaar (een reeks gewone
// besluiten) en is het onderwerp klein of routine? Antwoordt de AI duidelijk
// "nee" (groot: false), dan blijft het item niet-rood. Alles anders (ja, twijfel,
// een fout, quotum op, geen antwoord) laat de berekening beslissen.
//
// Deze module praat zelf niet met Google. zanp.js geeft de aanroep mee
// (roepGeminiWire), zodat het dagquotum en de tellers van ZANP gewoon blijven
// kloppen. Zo blijft de prioriteitsmodule los van het pitchdeel.

"use strict";

function bouwVetoPrompt(items) {
  const blok = (it, i) => {
    const bewijs = (it.bewijs || [])
      .map((b) => `  - ${b.bron || "?"}, ${String(b.datum || "").slice(0, 10)}: ${String(b.titel || "").slice(0, 140)}`)
      .join("\n");
    return (
      `ONDERWERP ${i + 1}\n` +
      `Soort: ${it.soort === "agenda" ? "agenda-item" : "nieuwsbericht"}\n` +
      `Titel: ${String(it.kop || "").slice(0, 200)}\n` +
      (it.kern ? `Begin van de tekst: ${String(it.kern).slice(0, 200)}\n` : "") +
      `Zoekwoorden: ${(it.ankers || []).slice(0, 4).join(", ")}\n` +
      `Wat de berekening vond: ${it.reden || ""}\n` +
      `Stukken waarop dat steunt:\n${bewijs || "  (geen)"}`
    );
  };
  return `Je controleert voor een lokale nieuwsredactie in de Zaanstreek (Nederland) het werk van een rekenmodel. Het model denkt dat de onderstaande onderwerpen "groot leven": er is veel over geschreven of besproken, met gevolgen voor inwoners. Jij mag een onderwerp alleen tegenhouden, nooit toevoegen.

Antwoord "groot": false ALLEEN als het duidelijk niet klopt:
- de stukken lijken op elkaar omdat het hetzelfde soort stuk is (verkeersbesluiten, vergunningen, bekendmakingen, agenda's, collegeberichten) maar ze gaan over verschillende zaken; of
- het onderwerp is klein, routine of puur administratief en heeft geen duidelijke gevolgen voor inwoners.
Twijfel je, of gaat het echt over een groot onderwerp (incident, conflict, groot besluit, veel betrokkenen, veel geld), antwoord dan "groot": true.

${items.map(blok).join("\n\n")}

Geef ALLEEN geldige JSON terug, geen markdown-fences en geen andere tekst. Precies één object per onderwerp, met het nummer van het onderwerp:
{ "antwoorden": [ { "nr": 1, "groot": true } ] }`;
}

function leesAntwoorden(data, aantal) {
  let lijst = [];
  if (Array.isArray(data)) lijst = data;
  else if (data && Array.isArray(data.antwoorden)) lijst = data.antwoorden;
  else if (data && aantal === 1 && typeof data.groot === "boolean") lijst = [{ ...data, nr: 1 }];
  const perNr = new Map();
  for (const a of lijst) {
    const nr = Number(a && a.nr);
    if (Number.isInteger(nr) && !perNr.has(nr)) perNr.set(nr, a);
  }
  return perNr;
}

/**
 * Maakt de aiVeto-functie voor beslis.js.
 *
 * @param {object}   o
 * @param {Function} o.roep           async (prompt, apiKey, maxTokens) => { data, verzoeken } (roepGeminiWire)
 * @param {string}   o.apiKey
 * @param {number}   o.ruimte         hoogstens zoveel verzoeken (dagquotum van ZANP)
 * @param {Function} [o.telVerzoeken] (aantal) => void, voor de tellers van ZANP
 * @param {Function} [o.bijQuotum]    (foutTekst) => void, bij een 429
 * @param {object}   [o.log]
 * @returns {Function} async (items, { maxVerzoeken, perVerzoek }) => Map key -> boolean (groot)
 */
function maakAiVeto({ roep, apiKey, ruimte, telVerzoeken = () => {}, bijQuotum = () => {}, log = console }) {
  return async function aiVeto(items, { maxVerzoeken = 2, perVerzoek = 6 } = {}) {
    const uit = new Map();
    let over = Math.max(0, Math.min(ruimte, maxVerzoeken));
    for (let i = 0; i < items.length && over > 0; i += perVerzoek) {
      const groep = items.slice(i, i + perVerzoek);
      over--;
      let antwoord;
      try {
        antwoord = await roep(bouwVetoPrompt(groep), apiKey, 2048);
      } catch (fout) {
        telVerzoeken(fout.verzoeken || 0);
        if (fout.status === 429) {
          bijQuotum(fout.message);
          log.warn(`[prioriteit] AI-quotum bereikt bij de controle; de berekening beslist.`);
          break;
        }
        log.warn(`[prioriteit] AI-controle mislukte voor ${groep.length} item(s); de berekening beslist: ${fout.message}`);
        continue;
      }
      telVerzoeken(antwoord.verzoeken || 0);
      const perNr = leesAntwoorden(antwoord.data, groep.length);
      groep.forEach((it, j) => {
        const a = perNr.get(j + 1);
        if (a && typeof a.groot === "boolean") uit.set(it.key, a.groot);
      });
    }
    return uit;
  };
}

module.exports = { maakAiVeto, bouwVetoPrompt, leesAntwoorden };
