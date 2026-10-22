// gemini.js
//
// Roept Gemini aan voor twee taken:
//   1. beoordeelBerichten — het criteria-filter. Draait alleen nog voor
//      agenda (afspraak 1 en 2 van de review). Nieuws slaat dit filter over.
//   2. genereerPitches — de pitch. Draait voor alle nieuws + de agenda die
//      het filter heeft gehaald. Vier velden: werktitel, samenvatting,
//      invalshoek, vraag (afspraak 3).
//
// Sinds de "pitch-en-filter-uit-elkaar"-ronde (2026-10-22):
//  - Nieuws gaat niet meer door het criteria-filter.
//  - beoordeelBerichten draait alleen nog voor agenda. Citaat-controle blijft.
//  - genereerPitches gebruikt de korte prompt: rol + taak + vier velden +
//    JSON-schema + bericht (afspraak 9-14).
//  - Voorbeelden: 1 werktitel, 1 samenvatting, 2 invalshoek, 2 vraag.
//    Elk voorbeeld heeft een ander onderwerp (afspraak 11 en 15).
//  - Lezer expliciet genoemd: "voor inwoners van Zaanstreek-Waterland"
//    (afspraak 17).
//  - Geen criteria, geen genre, geen bellijst, geen citaten in de pitch.
//    "Wat betekent dit voor…" mag (afspraak 12-14).
//  - Sorteren op codescore is weg; sortering op datum gebeurt in index.js.

const {
  KERN_CRITERIA,
  VERSTERKER_CRITERIA,
  berekenScore,
  bouwCriteriaTekst,
} = require("./nieuwscriteria");

const PROMPT_VERSIE = "2026-10-22-pitch-vier-velden";

// Afspraak 18: hetzelfde model als nu, met dezelfde fallback-keten.
const MODELLEN = {
  filter: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"],
  pitch: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-pro-latest"],
  sterker: ["gemini-flash-latest", "gemini-pro-latest"],
};

const MAX_OUTPUT_TOKENS = 2048;
const TEMPERATUUR_FILTER = 0.2;
const TEMPERATUUR_PITCH = 0.3;
const PARALLEL = 3;

// ---------------------------------------------------------------------------
// Gemini-aanroep
// ---------------------------------------------------------------------------

async function roepGeminiAan(model, prompt, apiKey, temperatuur) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: temperatuur,
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
    }
  );
  if (!response.ok) {
    let foutTekst = `HTTP ${response.status}`;
    try {
      const foutJson = await response.json();
      if (foutJson.error && foutJson.error.message) foutTekst += `: ${foutJson.error.message}`;
    } catch {
      // geen JSON, laat de HTTP-status staan
    }
    throw new Error(foutTekst);
  }
  const data = await response.json();
  const kandidaat = data && data.candidates && data.candidates[0];
  const delen = (kandidaat && kandidaat.content && kandidaat.content.parts) || [];
  const tekst = delen
    .filter((d) => !d.thought && typeof d.text === "string")
    .map((d) => d.text)
    .join("");
  if (!tekst) {
    throw new Error(`leeg antwoord (finishReason: ${(kandidaat && kandidaat.finishReason) || "onbekend"})`);
  }
  return tekst;
}

function parseAntwoord(tekst) {
  if (typeof tekst !== "string") return null;
  const schoon = tekst.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(schoon);
  } catch {
    const begin = schoon.indexOf("{");
    const eind = schoon.lastIndexOf("}");
    if (begin !== -1 && eind > begin) {
      try {
        return JSON.parse(schoon.slice(begin, eind + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function roepGeminiMetFallback(modellen, prompt, apiKey, temperatuur, log = console) {
  let laatsteFout;
  for (const model of modellen) {
    try {
      const tekst = await roepGeminiAan(model, prompt, apiKey, temperatuur);
      const data = parseAntwoord(tekst);
      if (data) return data;
      laatsteFout = new Error("antwoord is geen geldige JSON");
      log.warn(`  Gemini (${model}) gaf geen geldige JSON; probeer het volgende model.`);
    } catch (fout) {
      laatsteFout = fout;
      log.warn(`  Gemini (${model}) mislukte: ${fout.message}; probeer het volgende model.`);
    }
  }
  throw laatsteFout || new Error("alle modellen faalden");
}

// ---------------------------------------------------------------------------
// Filter (alleen voor agenda)
// ---------------------------------------------------------------------------

function bouwFilterPrompt(bericht, categorie) {
  const criteria = bouwCriteriaTekst(categorie);
  const landelijkVeld = categorie === "landelijk" ? ',\n    "lokaleRelevantie": 0' : "";
  return `Je bent een lokale journalist voor inwoners van Zaanstreek-Waterland.
Beoordeel het onderstaande agenda-item op de nieuwscriteria en de citaat-controle.

CRITERIA:
${criteria}

CITAAT-CONTROLE:
Controleer of het item een letterlijk citaat bevat dat als citaat in het artikel kan worden gebruikt. Geef in "citaatControle" aan of er een bruikbaar citaat in de tekst staat en welke dat is. Een item zonder bruikbaar citaat is geen reden om het af te keuren; de citaat-controle is een hulpmiddel, geen drempel.

Geef ALLEEN geldige JSON terug, exact dit formaat, geen markdown-fences en geen andere tekst:
{
  "scores": {
    "belang": 0, "omvang": 0, "afwijking": 0, "inzicht": 0, "gevolgen": 0,
    "wie": 0, "nieuwsVanMorgen": 0, "voorHetEerst": 0, "primeur": 0, "amusement": 0${landelijkVeld}
  },
  "onderbouwing": "korte uitleg van de scores",
  "centraleVraag": "concrete onderzoeksvraag",
  "invalshoek": "vanuit welk perspectief je dit brengt",
  "bronnen": ["bron 1", "bron 2"],
  "citaatControle": { "heeftCitaat": false, "citaat": "" }
}

BERICHT:
Titel: ${bericht.titel || ""}
Bron: ${bericht.bronNaam || ""}
Datum: ${bericht.gepubliceerdOp || ""}
Tekst:
${(bericht.samenvatting || "").trim() || "(geen tekst beschikbaar)"}`;
}

function valideerScores(scores, categorie) {
  const geldig = {};
  const kernIds = categorie === "landelijk"
    ? [...KERN_CRITERIA, "lokaleRelevantie"]
    : KERN_CRITERIA;
  for (const id of kernIds) {
    const waarde = scores && scores[id];
    geldig[id] = typeof waarde === "number" && waarde >= 0 && waarde <= 3 ? waarde : 0;
  }
  for (const id of VERSTERKER_CRITERIA) {
    const waarde = scores && scores[id];
    geldig[id] = typeof waarde === "number" && waarde >= 0 && waarde <= 3 ? waarde : 0;
  }
  return geldig;
}

async function beoordeelBerichtVoorAgenda(bericht, apiKey, categorie) {
  const prompt = bouwFilterPrompt(bericht, categorie);
  const data = await roepGeminiMetFallback(MODELLEN.filter, prompt, apiKey, TEMPERATUUR_FILTER);
  if (!data || !data.scores) throw new Error("geen scores in antwoord");
  const scores = valideerScores(data.scores, categorie);
  const score = berekenScore(scores, categorie);
  return {
    ...bericht,
    aiBeoordeling: {
      ...(bericht.aiBeoordeling || {}),
      scores,
      score,
      onderbouwing: data.onderbouwing || "",
      centraleVraag: data.centraleVraag || "",
      invalshoek: data.invalshoek || "",
      bronnen: Array.isArray(data.bronnen) ? data.bronnen : [],
      citaatControle: data.citaatControle || null,
    },
  };
}

async function beoordeelBerichten(berichten, apiKey, cap, categorie) {
  if (!Array.isArray(berichten) || berichten.length === 0) return berichten || [];
  const resultaten = [...berichten];
  const teDoen = berichten.slice(0, cap);

  for (let i = 0; i < teDoen.length; i += PARALLEL) {
    const batch = teDoen.slice(i, i + PARALLEL);
    await Promise.all(
      batch.map(async (bericht, j) => {
        const idx = i + j;
        try {
          resultaten[idx] = await beoordeelBerichtVoorAgenda(bericht, apiKey, categorie);
        } catch (fout) {
          resultaten[idx] = { ...bericht, aiFout: `filter: ${fout.message}` };
        }
      })
    );
    const gedaan = Math.min(i + PARALLEL, teDoen.length);
    if (gedaan % 10 === 0 || gedaan === teDoen.length) {
      console.log(`  filter: ${gedaan}/${teDoen.length} agenda-items`);
    }
  }
  for (let i = cap; i < berichten.length; i++) {
    if (!resultaten[i].aiFout) {
      resultaten[i] = { ...resultaten[i], aiFout: `filter: overgeslagen (dagcap ${cap})` };
    }
  }
  return resultaten;
}

// ---------------------------------------------------------------------------
// Pitch (voor alle berichten)
// ---------------------------------------------------------------------------

function bouwPitchPrompt(bericht) {
  const tekst = (bericht.samenvatting || "").trim();
  const tekstDeel = tekst || "(geen tekst beschikbaar)";
  return `Je bent een lokale journalist voor inwoners van Zaanstreek-Waterland.
Maak van het onderstaande bericht een korte pitch met vier velden.

VELDEN:

werktitel
Definitie: de kop boven het uiteindelijke artikel.
Eis: informatief én aantrekkelijk — de lezer ziet meteen waar het over gaat én wordt nieuwsgierig.
Voorbeeld: "Poller Russische Buurt gaat definitief omlaag — bewoners vechten terug"

samenvatting
Definitie: in twee of drie zinnen de kern van het bericht: onderwerp + uitspraak.
Eis: noem het onderwerp en de belangrijkste uitspraak of gebeurtenis. Geen interpretatie, geen oordeel.
Voorbeeld: "De Rekenkamer Amsterdam-Zaanstad twijfelt aan de financiële onderbouwing van de Zaanse begroting. Volgens de Rekenkamer ontbreken concrete plannen voor € 3,6 miljoen aan bezuinigingen in 2029 en € 3,1 miljoen in 2030."

invalshoek
Definitie: het perspectief van waaruit je het bericht brengt, plus een concrete hoek.
Eis: kies één van vier perspectieven — menselijk, institutioneel, maatschappelijk of lokaal — en maak de hoek concreet (wie, wat, waar).
Voorbeeld 1 (menselijk): "Vanuit de bewoners van de Russische Buurt die al jaren pleiten voor een veilige straat."
Voorbeeld 2 (institutioneel): "Vanuit de gemeenteraad die donderdag de begroting bespreekt."

vraag
Definitie: de centrale onderzoeksvraag voor het artikel.
Eis: concreet (met naam, getal of plek) en niet in het bericht zelf te beantwoorden. "Wat betekent dit voor…" is een prima vorm; ook "Hoeveel…?", "Wie besloot…?" of "Wanneer…?" mag.
Voorbeeld 1 (Wat betekent dit voor…): "Wat betekent het definitief zakken van de poller voor de verkeersveiligheid op de Hogendijk?"
Voorbeeld 2 (Hoeveel…): "Hoeveel van de € 3,6 miljoen aan bezuinigingen in 2029 is al concreet ingevuld?"

Regels:
- Schrijf voor inwoners van Zaanstreek-Waterland.
- Geen bellijst, geen citaten, geen feitenlijst, geen genre, geen verboden-lijstjes.
- Gebruik alleen wat in het bericht staat; verzin geen feiten.

Geef ALLEEN geldige JSON terug, exact dit formaat, geen markdown-fences en geen andere tekst:
{
  "werktitel": "...",
  "samenvatting": "...",
  "invalshoek": "...",
  "vraag": "..."
}

BERICHT:
Titel: ${bericht.titel || ""}
Bron: ${bericht.bronNaam || ""}
Datum: ${bericht.gepubliceerdOp || ""}
Tekst:
${tekstDeel}`;
}

function valideerPitch(data) {
  if (!data || typeof data !== "object") return null;
  const velden = ["werktitel", "samenvatting", "invalshoek", "vraag"];
  for (const veld of velden) {
    if (typeof data[veld] !== "string" || !data[veld].trim()) return null;
  }
  return {
    werktitel: data.werktitel.trim(),
    samenvatting: data.samenvatting.trim(),
    invalshoek: data.invalshoek.trim(),
    vraag: data.vraag.trim(),
  };
}

async function genereerPitchVoorBericht(bericht, apiKey) {
  const prompt = bouwPitchPrompt(bericht);
  const data = await roepGeminiMetFallback(MODELLEN.pitch, prompt, apiKey, TEMPERATUUR_PITCH);
  const pitch = valideerPitch(data);
  if (!pitch) throw new Error("onvolledige pitch (een of meer velden ontbreken)");
  return {
    ...bericht,
    aiBeoordeling: {
      ...(bericht.aiBeoordeling || {}),
      werktitel: pitch.werktitel,
      samenvatting: pitch.samenvatting,
      invalshoek: pitch.invalshoek,
      vraag: pitch.vraag,
      centraleVraag: pitch.vraag,
    },
  };
}

async function genereerPitches(berichten, apiKey, cap, categorie) {
  if (!Array.isArray(berichten) || berichten.length === 0) return berichten || [];
  const resultaten = [...berichten];
  const teDoen = berichten.slice(0, cap);

  for (let i = 0; i < teDoen.length; i += PARALLEL) {
    const batch = teDoen.slice(i, i + PARALLEL);
    await Promise.all(
      batch.map(async (bericht, j) => {
        const idx = i + j;
        try {
          resultaten[idx] = await genereerPitchVoorBericht(bericht, apiKey);
        } catch (fout) {
          resultaten[idx] = { ...bericht, aiFout: `pitch: ${fout.message}` };
        }
      })
    );
    const gedaan = Math.min(i + PARALLEL, teDoen.length);
    if (gedaan % 10 === 0 || gedaan === teDoen.length) {
      console.log(`  pitch: ${gedaan}/${teDoen.length} berichten`);
    }
  }
  for (let i = cap; i < berichten.length; i++) {
    if (!resultaten[i].aiFout) {
      resultaten[i] = { ...resultaten[i], aiFout: `pitch: overgeslagen (dagcap ${cap})` };
    }
  }
  return resultaten;
}

module.exports = {
  beoordeelBerichten,
  genereerPitches,
  PROMPT_VERSIE,
  MODELLEN,
  bouwFilterPrompt,
  bouwPitchPrompt,
  valideerPitch,
  valideerScores,
  parseAntwoord,
};
