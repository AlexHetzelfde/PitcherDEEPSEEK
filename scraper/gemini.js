// gemini.js
//
// Roept Gemini aan voor drie taken:
//   1. beoordeelBerichten — het criteria-filter. Draait alleen nog voor
//      agenda (afspraak 1 en 2 van de review). Nieuws slaat dit filter over.
//   2. genereerPitches — de pitch. Draait voor alle nieuws + de agenda die
//      het filter heeft gehaald. Vier velden: werktitel, samenvatting,
//      invalshoek, vraag (afspraak 3).
//   3. schrijfMeldingen — de nieuwsdienst (ZANP). Twee modi: "volledig" maakt
//      van een officiële bron of een persbericht een korte, feitelijke
//      melding (kop, tekst, prio); "analyse" schrijft GEEN tekst en haalt
//      alleen een checklist en agendapunten uit de bron (artikelen van
//      andere redacties). Wie volledig mag, bepaalt rubrieken.json. De
//      uitvoer wordt in wire.js gecontroleerd tegen de bron.
//   4. beslisZelfdeNieuwsfeit — voor dubbel nieuws, alleen bij twijfelgevallen.
//
// Sinds 2026-10-26:
//  - ZANP draait op gemini-flash-lite-latest (ruimer gratis quotum).
//  - Stroomonderbreker: bij een 429 stopt schrijfMeldingen direct met
//    verdere batches, zodat we geen tijd en quota verspillen.
//
// Sinds 2026-10-29:
//  - De pitchrun staat weer op gemini-flash-latest voor ALLE taken: het
//    agenda-filter (beoordeelBerichten) had per ongeluk Flash-Lite gekregen.
//    Pitchfuncties en -prompts zijn niet aangeraakt.
//  - ZANP werkt in batches: tot BATCH_GROOTTE berichten per verzoek, want het
//    quotum telt verzoeken. De cap van schrijfMeldingen en
//    beslisZelfdeNieuwsfeit is dus een aantal VERZOEKEN. Het resultaat heeft
//    een eigenschap "verzoeken" met het aantal beantwoorde verzoeken.
//  - De melding bevat ook een tag (kolom) uit een gesloten lijst.

const {
  KERN_CRITERIA,
  VERSTERKER_CRITERIA,
  berekenScore,
  bouwCriteriaTekst,
} = require("./nieuwscriteria");

const PROMPT_VERSIE = "2026-10-22-pitch-vier-velden";
const PROMPT_VERSIE_WIRE = "2026-10-29-batch-tag-checklist-agendapunten";

// De pitchrun (index.js) gebruikt filter, pitch en sterker en draait op Flash.
// ZANP gebruikt alleen "wire", op Flash-Lite met een ruimer quotum.
const MODELLEN = {
  filter: ["gemini-flash-latest"],    // pitchrun: agenda-filter (index.js)
  pitch: ["gemini-flash-latest"],     // pitchrun
  sterker: ["gemini-flash-latest"],   // pitchrun
  wire: ["gemini-flash-lite-latest"], // ZANP: meldingen, analyses en dubbel nieuws
};

const MAX_OUTPUT_TOKENS = 2048;
const TEMPERATUUR_FILTER = 0.2;
const TEMPERATUUR_PITCH = 0.3;
const TEMPERATUUR_WIRE = 0.1; // feiten overnemen, niet fantaseren
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
    const error = new Error(foutTekst);
    error.status = response.status;
    throw error;
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

// ---------------------------------------------------------------------------
// Melding voor de nieuwsdienst (ZANP)
// ---------------------------------------------------------------------------
//
// Twee modi per bericht:
//   "volledig"  kop, tekst, prio, tag + checklist + agendapunten (officiële en
//               organisatiebronnen die we mogen herschrijven)
//   "analyse"   alleen tag + checklist + agendapunten, GEEN tekst (artikelen
//               van andere redacties en onbekende bronnen)
// Alles wat de AI teruggeeft wordt in wire.js gecontroleerd tegen de bron.
//
// BATCHES. Het gratis quotum telt VERZOEKEN, geen tokens. Daarom gaan er per
// verzoek maximaal BATCH_GROOTTE berichten mee (van dezelfde modus). Elk
// bericht wordt apart gecontroleerd; een deels bruikbaar antwoord blijft
// bruikbaar en wat ontbreekt wordt bij een volgende run opnieuw geprobeerd.
//
// De functies hieronder gebruiken een EIGEN aanroep (roepGeminiWire) en raken
// de aanroepen van de pitchrun dus niet aan.

const BATCH_GROOTTE = 6; // berichten per verzoek
const BATCH_TEKENS_PER_ITEM = 3000; // brontekst per bericht in een batch
const MAX_OUTPUT_TOKENS_BATCH = 8192; // een batch heeft meer uitvoer nodig dan één bericht
const ZELFDE_PER_VERZOEK = 10; // twijfelparen per verzoek (dubbel nieuws)

/**
 * Eén Gemini-aanroep voor ZANP. Zelfde protocol als roepGeminiAan, maar met
 * een eigen uitvoerlimiet en zonder iets aan de pitchrun te veranderen.
 * Geeft { data, verzoeken } terug; "verzoeken" telt de aanroepen die Google
 * heeft beantwoord (ook een antwoord dat geen geldige JSON bleek te zijn), want
 * die tellen mee voor het dagquotum. Een HTTP-fout telt niet.
 */
async function roepGeminiWire(prompt, apiKey, maxTokens = MAX_OUTPUT_TOKENS_BATCH) {
  let verzoeken = 0;
  let laatsteFout;
  for (const model of MODELLEN.wire) {
    let tekst;
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: TEMPERATUUR_WIRE,
              responseMimeType: "application/json",
              maxOutputTokens: maxTokens,
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
        const fout = new Error(foutTekst);
        fout.status = response.status;
        throw fout;
      }
      verzoeken++;
      const antwoord = await response.json();
      const kandidaat = antwoord && antwoord.candidates && antwoord.candidates[0];
      const delen = (kandidaat && kandidaat.content && kandidaat.content.parts) || [];
      tekst = delen
        .filter((d) => !d.thought && typeof d.text === "string")
        .map((d) => d.text)
        .join("");
      if (!tekst) {
        throw new Error(`leeg antwoord (finishReason: ${(kandidaat && kandidaat.finishReason) || "onbekend"})`);
      }
    } catch (fout) {
      laatsteFout = fout;
      console.warn(`  Gemini (${model}) mislukte: ${fout.message}`);
      continue;
    }
    const data = parseAntwoord(tekst);
    if (data) return { data, verzoeken };
    laatsteFout = new Error("antwoord is geen geldige JSON");
    console.warn(`  Gemini (${model}) gaf geen geldige JSON.`);
  }
  const fout = laatsteFout || new Error("alle modellen faalden");
  fout.verzoeken = verzoeken;
  throw fout;
}

const CHECKLIST_UITLEG = `CHECKLIST (feiten uit de bron; bij twijfel false of null):
- gevaar: true bij acuut gevaar voor mensen (brand, gaslek, instortingsgevaar, ernstig ongeval). Niet bij gewone wegwerkzaamheden.
- evacuatieOfNlAlert: true als er sprake is van ontruiming, evacuatie of een NL-Alert.
- gewondenOfDoden: true als er gewonden of doden worden genoemd.
- betrokkenen: het aantal getroffenen, gewonden of ontruimden als getal dat letterlijk in de bron staat, anders null.
- geldbedragEuro: een bedrag in euro dat letterlijk in de bron staat, in hele euro's (2,5 miljoen wordt 2500000), anders null.
- banen: het aantal banen dat verdwijnt of erbij komt, als getal dat letterlijk in de bron staat, anders null.
- bestuurlijkeCrisis: true bij aftreden of schorsing van een bestuurder, motie van wantrouwen, coalitiebreuk of integriteitsonderzoek naar bestuurders.
- besluitMetGrootGevolg: true bij een besluit dat veel inwoners direct raakt (sluiting van een voorziening, grote bouwplannen, belastingverhoging).
- tijdkritisch: true als het nu speelt of binnen enkele uren, en mensen direct moeten handelen.`;

const AGENDAPUNTEN_UITLEG = `AGENDAPUNTEN (optioneel, hooguit 3):
Alleen openbare bijeenkomsten, zittingen, inspraakmomenten, inloopavonden of evenementen met een concrete datum in de toekomst die in de tekst staat. Geen deadlines (die vindt de code zelf), geen gebeurtenissen uit het verleden. Staat er geen datum in de tekst, laat het punt dan weg.
Per punt:
  "titel": maximaal 12 woorden
  "datumTekst": de datum EXACT zoals in de bron geschreven, bijvoorbeeld "dinsdag 3 november" of "morgen"
  "tijd": de begintijd exact zoals in de bron ("19.30 uur"), of null
  "eindtijd": de eindtijd exact zoals in de bron, of null
  "plaats": de plaats of locatie exact zoals in de bron, of null`;

const CHECKLIST_VOORBEELD = `"checklist": {
      "gevaar": false,
      "evacuatieOfNlAlert": false,
      "gewondenOfDoden": false,
      "betrokkenen": null,
      "geldbedragEuro": null,
      "banen": null,
      "bestuurlijkeCrisis": false,
      "besluitMetGrootGevolg": false,
      "tijdkritisch": false
    },
    "agendapunten": []`;

// De tag (kolom) van een bericht: waar gaat het OVER, niet waar komt het
// vandaan. tags = [{ code, naam, hint }] uit rubrieken.json (zie tags.js).
function tagUitleg(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "";
  const regels = tags.map((t) => `  ${t.code}: ${t.naam}${t.hint ? ` (${t.hint})` : ""}`).join("\n");
  return `TAG (kies precies één code uit deze lijst; het gaat erom waar het bericht OVER gaat, niet om de bron):
${regels}
  ALG: geen van bovenstaande past`;
}

function bronBlok(item, nr) {
  const tekst = (item.tekst || "").trim().slice(0, BATCH_TEKENS_PER_ITEM);
  return `BRON ${nr}:
Titel: ${item.titel || ""}
Bron: ${item.bronNaam || ""}
Datum: ${item.gepubliceerdOp || ""}
Tekst:
${tekst || "(geen tekst beschikbaar)"}`;
}

/**
 * Eén prompt voor een groep berichten van dezelfde modus. Het voorbeeld is
 * bewust verzonnen, zodat het model het niet overneemt.
 */
function bouwMeldingBatchPrompt(items, modus = "volledig", tags = []) {
  const volledig = modus !== "analyse";
  const n = items.length;
  const tag = tagUitleg(tags);
  const tagVeld = tag ? `\n      "tag": "<code uit de lijst>",` : "";

  const intro = volledig
    ? `Je bent redacteur bij een regionale nieuwsdienst voor Zaanstreek-Waterland, in de stijl van een persbureau: kort, feitelijk en neutraal.
Hieronder staan ${n} bron(nen). Schrijf voor ELKE bron een melding met een kop, een tekst, een prio${tag ? ", een tag" : ""}, een checklist en eventueel agendapunten. Behandel elke bron los van de andere: gebruik voor een melding alleen de tekst van die ene bron.

kop
Eis: maximaal 14 woorden, tegenwoordige tijd, feitelijk. Noem wie of wat en de kern. Geen vraag, geen aanloktaal, geen uitroepteken.
Voorbeeld: "Fietspad langs de Vaart in Wormer twee weken dicht voor onderhoud"

tekst
Eis: twee tot vier zinnen over wie of wat, waar, wanneer en wat het concreet betekent. Uitsluitend feiten uit de bron. Geen oordeel, geen citaten, geen achtergrond uit eigen kennis.
Voorbeeld: "De gemeente knapt van 3 tot en met 14 maart het fietspad langs de Vaart op. Fietsers worden in die periode omgeleid via de Dorpsstraat."

prio
Een geheel getal van 2 tot en met 4:
  2: raakt veel inwoners of heeft direct gevolgen voor het dagelijks leven (verkeer, veiligheid, zorg, geld).
  3: relevant voor een kleinere groep, of een belangrijk besluit.
  4: routine of administratief (vergunning, bekendmaking, persbericht van een instelling).`
    : `Je analyseert berichten voor een regionale nieuwsdienst voor Zaanstreek-Waterland. Hieronder staan ${n} bron(nen). Je schrijft zelf geen tekst: je kiest ${tag ? "een tag, " : ""}vult een checklist in en haalt eventuele agendapunten uit de bron. Behandel elke bron los van de andere.`;

  const regels = volledig
    ? `REGELS:
- Gebruik alleen wat in de bron staat. Staat iets er niet in, laat het dan weg. Verzin geen namen, getallen, data of plaatsen.
- Neem getallen letterlijk over; reken niets om en tel niets op.
- Is de brontekst te kort of te onduidelijk voor een melding, antwoord voor die bron dan {"nr": <nummer>, "onvoldoende": true}.
- Schrijf in correct, helder Nederlands.`
    : `REGELS:
- Gebruik alleen wat in de bron staat. Verzin geen getallen, data of plaatsen.
- Is de brontekst te kort of te onduidelijk, antwoord voor die bron dan {"nr": <nummer>, "onvoldoende": true}.`;

  const voorbeeld = volledig
    ? `    {
      "nr": 1,
      "kop": "...",
      "tekst": "...",
      "prio": 3,${tagVeld}
      ${CHECKLIST_VOORBEELD}
    }`
    : `    {
      "nr": 1,${tagVeld}
      ${CHECKLIST_VOORBEELD}
    }`;

  return `${intro}

${tag ? `${tag}\n\n` : ""}${CHECKLIST_UITLEG}

${AGENDAPUNTEN_UITLEG}

${regels}

Geef ALLEEN geldige JSON terug, geen markdown-fences en geen andere tekst. Precies één object per bron, met het nummer van die bron, in dezelfde volgorde:
{
  "resultaten": [
${voorbeeld}
  ]
}

${items.map((item, i) => bronBlok(item, i + 1)).join("\n\n")}`;
}

// Geeft { onvoldoende: true } of { kop, tekst, prio, tag, checklist, agendapunten }
// terug, of null bij een onbruikbaar antwoord. Checklist, agendapunten en tag
// gaan ongecontroleerd door; wire.js controleert ze tegen de bron en de lijst.
function valideerMelding(data, modus = "volledig") {
  if (!data || typeof data !== "object") return null;
  if (data.onvoldoende === true) return { onvoldoende: true };

  const checklist = data.checklist && typeof data.checklist === "object" ? data.checklist : null;
  const agendapunten = Array.isArray(data.agendapunten) ? data.agendapunten : [];
  const tag = typeof data.tag === "string" && data.tag.trim() ? data.tag.trim() : null;

  if (modus === "analyse") {
    if (!checklist) return null;
    return { checklist, agendapunten, tag };
  }

  for (const veld of ["kop", "tekst"]) {
    if (typeof data[veld] !== "string" || !data[veld].trim()) return null;
  }
  const kop = data.kop.trim();
  if (kop.length > 160) return null;
  const prio = Number(data.prio);
  return {
    kop,
    tekst: data.tekst.trim(),
    prio: Number.isInteger(prio) ? prio : null,
    tag,
    checklist,
    agendapunten,
  };
}

// Groepeert items in batches van dezelfde modus, in de volgorde van de lijst
// (de lijst is al op belang gesorteerd). Een batch staat op de plek van zijn
// eerste item.
function maakBatches(items, grootte) {
  const batches = [];
  const open = { volledig: null, analyse: null };
  for (const item of items) {
    const modus = item.modus === "analyse" ? "analyse" : "volledig";
    let batch = open[modus];
    if (!batch) {
      batch = { modus, items: [] };
      open[modus] = batch;
      batches.push(batch);
    }
    batch.items.push(item);
    if (batch.items.length >= grootte) open[modus] = null;
  }
  return batches;
}

/**
 * Schrijft meldingen of analyses voor een lijst items, in batches.
 *
 * @param {object[]} items  { id, modus, titel, tekst, bronNaam, gepubliceerdOp, ... }
 * @param {string}   apiKey
 * @param {number}   cap    hoogstens zoveel VERZOEKEN (niet berichten)
 * @param {object}   [opties] { tags: [{code,naam,hint}], batchGrootte }
 * @returns {Map} item.id naar { melding } | { onvoldoende: true } | { fout, status }.
 *   Op de Map staat ook "verzoeken": het aantal verzoeken dat Google beantwoordde
 *   (alleen die tellen voor het dagquotum).
 *
 * Items die niet aan bod kwamen (cap of quotum) krijgen { fout: "overgeslagen …" }
 * en worden bij een volgende run opnieuw geprobeerd.
 *
 * Stroomonderbreker: bij een 429 starten er geen nieuwe verzoeken meer.
 */
async function schrijfMeldingen(items, apiKey, cap, opties = {}) {
  const resultaten = new Map();
  resultaten.verzoeken = 0;
  if (!Array.isArray(items) || items.length === 0) return resultaten;

  const grootte = Math.max(1, opties.batchGrootte || BATCH_GROOTTE);
  const tags = opties.tags || [];
  const batches = maakBatches(items, grootte);
  const teDoen = batches.slice(0, Math.max(0, cap));

  let quotaHit = false;

  async function verwerkBatch(batch) {
    const prompt = bouwMeldingBatchPrompt(batch.items, batch.modus, tags);
    let antwoord;
    try {
      antwoord = await roepGeminiWire(prompt, apiKey);
    } catch (fout) {
      resultaten.verzoeken += fout.verzoeken || 0;
      for (const item of batch.items) resultaten.set(item.id, { fout: fout.message, status: fout.status });
      if (fout.status === 429) quotaHit = true;
      return;
    }
    resultaten.verzoeken += antwoord.verzoeken;

    let lijst = [];
    if (Array.isArray(antwoord.data)) lijst = antwoord.data;
    else if (Array.isArray(antwoord.data.resultaten)) lijst = antwoord.data.resultaten;
    else if (batch.items.length === 1 && (antwoord.data.kop || antwoord.data.checklist || antwoord.data.onvoldoende)) {
      lijst = [{ ...antwoord.data, nr: 1 }]; // het model gaf één los object
    }
    const perNr = new Map();
    for (const r of lijst) {
      const nr = Number(r && r.nr);
      if (Number.isInteger(nr) && !perNr.has(nr)) perNr.set(nr, r);
    }

    batch.items.forEach((item, i) => {
      const r = perNr.get(i + 1);
      if (!r) {
        resultaten.set(item.id, { fout: "ontbreekt in het antwoord" });
        return;
      }
      const melding = valideerMelding(r, batch.modus);
      if (!melding) {
        resultaten.set(item.id, {
          fout: batch.modus === "analyse" ? "onvolledige analyse (checklist ontbreekt)" : "onvolledige melding (kop of tekst ontbreekt)",
        });
        return;
      }
      resultaten.set(item.id, melding.onvoldoende ? { onvoldoende: true } : { melding });
    });
  }

  for (let i = 0; i < teDoen.length; i += PARALLEL) {
    if (quotaHit) break;
    await Promise.all(teDoen.slice(i, i + PARALLEL).map(verwerkBatch));
    const gedaan = Math.min(i + PARALLEL, teDoen.length);
    console.log(`  melding: ${gedaan}/${teDoen.length} verzoek(en), ${resultaten.size} bericht(en) verwerkt`);
  }

  for (const item of items) {
    if (!resultaten.has(item.id)) {
      resultaten.set(item.id, {
        fout: quotaHit ? "overgeslagen (quotum bereikt)" : `overgeslagen (cap ${cap} verzoeken)`,
      });
    }
  }
  return resultaten;
}

// ---------------------------------------------------------------------------
// Dubbel nieuws: gaat het om hetzelfde nieuwsfeit?
// ---------------------------------------------------------------------------

function bouwZelfdeBatchPrompt(paren) {
  const blok = (x) => `Titel: ${x.titel || ""}\nBron: ${x.bronNaam || ""}\nTekst: ${(x.tekst || "").slice(0, 500)}`;
  return `Hieronder staan ${paren.length} paar(en) berichten uit Zaanstreek-Waterland. Beoordeel elk paar los van de andere: gaat het om HETZELFDE nieuwsfeit, dus dezelfde gebeurtenis of hetzelfde besluit, ook als ze anders zijn geschreven?
Antwoord alleen "zelfde": true als het over dezelfde gebeurtenis gaat. Een vervolg, een reactie, een ander aspect of een soortgelijke maar andere gebeurtenis is "zelfde": false.

${paren
  .map((p, i) => `PAAR ${i + 1}\nBERICHT A\n${blok(p.a)}\n\nBERICHT B\n${blok(p.b)}`)
  .join("\n\n")}

Geef ALLEEN geldige JSON terug, geen markdown-fences en geen andere tekst. Precies één object per paar, met het nummer van het paar:
{ "antwoorden": [ { "nr": 1, "zelfde": true } ] }`;
}

/**
 * Beslist voor een lijst twijfelparen of ze hetzelfde nieuwsfeit zijn, tot
 * ZELFDE_PER_VERZOEK paren per verzoek.
 *
 * @param {object[]} paren  { sleutel, a, b }
 * @param {string}   apiKey
 * @param {number}   cap    hoogstens zoveel VERZOEKEN
 * @returns {Map} sleutel naar true | false | null (null bij een fout of
 *   overgeslagen). Op de Map staan ook "verzoeken" (beantwoorde verzoeken) en
 *   "quotum" (true bij een 429, met de melding in "quotumTekst"). Stopt bij een 429.
 */
async function beslisZelfdeNieuwsfeit(paren, apiKey, cap) {
  const uit = new Map();
  uit.verzoeken = 0;
  const lijst = paren || [];
  const groepen = [];
  for (let i = 0; i < lijst.length; i += ZELFDE_PER_VERZOEK) groepen.push(lijst.slice(i, i + ZELFDE_PER_VERZOEK));
  const teDoen = groepen.slice(0, Math.max(0, cap));

  let quotaHit = false;

  async function verwerkGroep(groep) {
    let antwoord;
    try {
      antwoord = await roepGeminiWire(bouwZelfdeBatchPrompt(groep), apiKey, 2048);
    } catch (fout) {
      uit.verzoeken += fout.verzoeken || 0;
      for (const paar of groep) uit.set(paar.sleutel, null);
      if (fout.status === 429) {
        quotaHit = true;
        uit.quotumTekst = fout.message;
      }
      return;
    }
    uit.verzoeken += antwoord.verzoeken;
    let antwoorden = [];
    if (Array.isArray(antwoord.data)) antwoorden = antwoord.data;
    else if (Array.isArray(antwoord.data.antwoorden)) antwoorden = antwoord.data.antwoorden;
    else if (groep.length === 1 && typeof antwoord.data.zelfde === "boolean") antwoorden = [{ ...antwoord.data, nr: 1 }];
    const perNr = new Map();
    for (const a of antwoorden) {
      const nr = Number(a && a.nr);
      if (Number.isInteger(nr) && !perNr.has(nr)) perNr.set(nr, a);
    }
    groep.forEach((paar, i) => {
      const a = perNr.get(i + 1);
      uit.set(paar.sleutel, a && typeof a.zelfde === "boolean" ? a.zelfde : null);
    });
  }

  for (let i = 0; i < teDoen.length; i += PARALLEL) {
    if (quotaHit) break;
    await Promise.all(teDoen.slice(i, i + PARALLEL).map(verwerkGroep));
  }
  for (const paar of lijst) {
    if (!uit.has(paar.sleutel)) uit.set(paar.sleutel, null);
  }
  uit.quotum = quotaHit;
  return uit;
}

module.exports = {
  beoordeelBerichten,
  genereerPitches,
  schrijfMeldingen,
  beslisZelfdeNieuwsfeit,
  PROMPT_VERSIE,
  PROMPT_VERSIE_WIRE,
  MODELLEN,
  BATCH_GROOTTE,
  ZELFDE_PER_VERZOEK,
  bouwFilterPrompt,
  bouwPitchPrompt,
  bouwMeldingBatchPrompt,
  bouwZelfdeBatchPrompt,
  maakBatches,
  valideerPitch,
  valideerMelding,
  valideerScores,
  parseAntwoord,
};
