// gemini.js
//
// Roept de Gemini API aan in DRIE stappen:
//
//   Call 1 (filter): bepaalt of het bericht nieuws is. Gebaseerd op de
//     nieuwscriteria uit het Basisboek journalistiek schrijven (pagina 153-155):
//     actualiteit, afwijking, voor het eerst, belang, nabijheid, omvang,
//     primeur, nieuws van morgen, wie, inzicht.
//
//   Call 2 (pitch): alleen voor berichten die door de filter komen. Maakt
//     een korte pitch met invalshoek, researchvraag en bronnen. GEEN
//     prioriteit — die komt uit call 3.
//
//   Call 3 (ranking): één keer per run, voor ALLE pitches gezamenlijk.
//
// Waarom drie calls:
//   - Filter en pitch zijn twee verschillende taken. Splitsen geeft elke
//     prompt gerichte aandacht.
//   - Ranking in één call ziet alle pitches naast elkaar.
//
// Sinds de "eerlijke-pipeline"-ronde (2026-10-15):
//  - De typfout "INVALSHEEK" is "INVALSHOEK" geworden.
//  - Bij "twijfel" wordt geen pitch-call meer gedaan. Die categorie komt
//    toch niet in de pitches (alleen "ja" voor lokaal, en "ja" voor
//    landelijk), dus de call en de 4,5 s pauze waren verspilde moeite en
//    API-kosten.
//  - fetchMetTimeout leest de body nu binnen de timeout. Voorheen werd de
//    timeout gewist zodra de headers binnen waren, en een trage body kon
//    dan onbeperkt doorlopen. De functie geeft nu { response, tekst } terug
//    zodat de aanroeper zelf JSON.parse doet.
//
// Verwacht de API-key in de omgevingsvariabele GEMINI_API_KEY.

const { oorzaakTekst } = require("./hulpmiddelen");

const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const PAUZE_TUSSEN_CALLS_MS = 4500;
const MAX_PITCHES_VOOR_RANKING = 50;

// ---------------------------------------------------------------------------
// FILTER-PROMPT (lokaal) — nieuwscriteria uit het boek
// ---------------------------------------------------------------------------

const PROMPT_LOKAAL_FILTER = `Je bent redactioneel assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één bericht uit een Zaanse bron, maximaal 1 dag oud. Bepaal of dit nieuws is.

Een bericht is nieuws als het aan minstens één van deze criteria voldoet:

AFWIJKING — het wijkt af van het alledaagse, is bijzonder of opvallend
AMUSEMENT — het is grappig of opvallend luchtig
BELANG — het raakt mensen in de regio, ook wie er niet direct bij betrokken is
BETEKENIS — het heeft consequenties voor het dagelijks leven van mensen
GROOTTE — de omvang maakt het belangrijk: veel mensen, veel geld, veel impact
VOOR HET EERST — een debuut, eerste editie, opening, jubileum, primeur.
  Signaalwoorden: "eerste", "debuut", "nieuw", "voor het eerst", "jubileum", "opening"
PRIMEUR — het is exclusief, als eerste naar buiten gebracht
NIEUWS VAN MORGEN — het kondigt iets aan dat nog gaat komen
BEKENDE — het gaat over een bekend persoon in de regio
INZICHT — het maakt een maatschappelijk probleem begrijpelijker

Actualiteit (max 1 dag oud) en nabijheid (Zaanse bron) gelden al voor elk bericht in deze stap. Ze zijn daarom alleen geen reden voor "ja".

Kies "ja" als minstens één criterium geldt en letterlijk in de tekst staat.
Kies "twijfel" als een criterium lijkt te gelden, maar de tekst te vaag is om het zeker te weten.
Kies "nee" als geen enkel criterium geldt.

Output (alleen geldige JSON, geen tekst eromheen):
{
  "oppakbaar": "ja" | "twijfel" | "nee",
  "onderbouwing": "max 2 zinnen: welk criterium wel of niet geldt"
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven, gevolgen of context die niet genoemd worden.`;

// ---------------------------------------------------------------------------
// FILTER-PROMPT (landelijk) — gebruikt alleen als er landelijke bronnen zijn.
// ---------------------------------------------------------------------------

const PROMPT_LANDELIJK_FILTER = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één landelijk nieuwsbericht, met de titel en de tekst van het bericht.
Regionale media kiezen bij landelijk nieuws bijna altijd voor een regionale insteek: ze
"regionaliseren" het onderwerp.

Jouw enige taak: bepaal of dit bericht een lokale invalshoek heeft voor Zaanstreek-
Waterland (Zaandam, Zaanstad, Wormerland, Oostzaan, Purmerend, Edam-Volendam, Waterland).

Zoek aanknopingspunten zoals:
- Voert de gemeente dit beleid uit, zodat inwoners van Zaanstad of Purmerend er iets van merken?
- Is er een sector (onderwijs, zorg, ondernemers, woningbouw, landbouw, industrie) of een
  landelijke instelling met een lokale vestiging die door dit nieuws geraakt wordt?
- Gaat het over een groep mensen die ook lokaal woont of werkt (bijvoorbeeld
  arbeidsmigranten, studenten, ouderen, zzp'ers, huurders)?
- Bestaat er een lokale of regionale uitsplitsing van de genoemde cijfers?

Staat er geen duidelijk gevolg voor mensen in het bericht, of kun je het alleen bedenken
door iets aan te nemen? Dan is het antwoord "nee".

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "lokaleInvalshoek": "ja" | "twijfel" | "nee",
  "onderbouwing": "max 2 zinnen: welk aanknopingspunt er is, of waarom er geen lokale invalshoek te vinden is"
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden.`;

// ---------------------------------------------------------------------------
// PITCH-PROMPT (lokaal) — kort, met invalshoek + researchvraag + bronnen.
// ---------------------------------------------------------------------------

const PROMPT_LOKAAL_PITCH = `Je bent redactioneel assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één bericht dat al als nieuws is beoordeeld. Maak een korte pitch voor
de dagelijkse nieuwsvergadering.

Een goede pitch is kort, concreet, en heeft drie dingen:
- een invalshoek: vanuit welk perspectief wordt het bekeken?
- een simpele researchvraag: wat gaat de journalist uitzoeken?
- bronnen: wie kan de journalist bellen?

Geef:

1. INVALSHOEK — vanuit welke hoek wordt het bekeken? Eén zin.
   Bijvoorbeeld: "vanuit gehandicapten in de Zaanstreek" of
   "vanuit de ondernemers in Zaandam die er last van hebben".

2. RESEARCHVRAAG — één simpele vraag in de vorm "Wat betekent dit voor [wie]?"
   Bijvoorbeeld: "Wat betekent dit voor gehandicapten in de Zaanstreek?"

3. BRONNEN — namen van personen, organisaties of bedrijven uit de tekst die
   de journalist kan bellen. Laat de lijst leeg als er geen namen in staan.
   Verzin geen namen.

Geef ALLEEN geldige JSON terug, in dit exacte formaat, zonder
markdown-fences of andere tekst:
{
  "invalshoek": "...",
  "researchvraag": "...",
  "bronnen": ["..."]
}

Laat velden leeg als ze niet uit de tekst volgen. Verzin niets.
Blijf strikt bij wat er staat.`;

// ---------------------------------------------------------------------------
// PITCH-PROMPT (landelijk) — gebruikt alleen als er landelijke bronnen zijn.
// ---------------------------------------------------------------------------

const PROMPT_LANDELIJK_PITCH = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één landelijk bericht dat al een lokale invalshoek heeft. Maak nu de pitch:
een voorgestelde kop, een korte uitleg van het gevolg voor de betrokken mensen, en
concrete vervolgstappen voor de journalist.

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "gevolgenVoor": "wie in Zaanstreek-Waterland wordt er geraakt, zo concreet als het bericht toelaat, anders leeg",
  "gevolg": "het concrete gevolg voor die persoon of groep, 1-2 zinnen, alleen wat in het bericht staat of er direct uit volgt, anders leeg",
  "aanleiding": "concrete, controleerbare aanleiding die logisch uit het bericht volgt, anders leeg",
  "voorgesteldeKop": "een pakkende, feitelijk onderbouwde kop voor het lokale artikel, anders leeg",
  "pitchUitleg": "2-4 zinnen die het gevolg voor de betrokken mensen uitwerken tot een bruikbare pitch, anders leeg",
  "vervolgstappen": ["concrete actie 1, bijv. wie te interviewen", "concrete actie 2, bijv. welk feit te checken"]
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden.`;

// ---------------------------------------------------------------------------
// RANKING-PROMPT — één keer per run, voor alle pitches gezamenlijk.
// ---------------------------------------------------------------------------

const PROMPT_RANKING = `Je bent redactioneel assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt een lijst met pitches voor de dagelijkse nieuwsvergadering. Geef elke pitch
een score van 1 tot 10 op basis van hoe groot of belangrijk het nieuws is.

Gebruik de nieuwscriteria (hoe meer en hoe sterker, hoe hoger de score):

OMVANG — hoe meer mensen, geld of impact, hoe belangrijker
AFWIJKING — hoe ongewoner, hoe belangrijker
ACTUALITEIT — hoe verser, hoe belangrijker
NABIJHEID — hoe dichter bij Zaanstreek-Waterland
PRIMEUR — als eerste naar buiten gebracht
VOOR HET EERST — debuut, eerste editie, opening, jubileum
NIEUWS VAN MORGEN — aankondiging van iets belangrijks dat komt
BEKENDE — bekende personen in de regio krijgen eerder aandacht
INZICHT — maakt een maatschappelijk probleem begrijpelijker

Schaal:
9-10 = groot nieuws (hoge omvang + meerdere andere criteria)
7-8  = duidelijk belangrijk (omvang of impact + 1 ander criterium)
4-6  = bescheiden nieuws (1 criterium of meerdere zwakke)
1-3  = klein nieuws (niche, kleine groep, geringe impact)

Geef ALLEEN geldige JSON terug, in dit exacte formaat, zonder
markdown-fences of andere tekst:
{
  "scores": [
    { "nr": 1, "score": 5 }
  ]
}

Geef één score per pitch. Gebruik het nummer ("nr") dat bij elke pitch staat.
Verzin geen nummers die er niet zijn, sla geen nummers over.`;

// ---------------------------------------------------------------------------
// Gemini aanroepen
// ---------------------------------------------------------------------------

function maakPrioriteit(waarde) {
  const getal = Math.round(Number(waarde));
  return waarde !== null && waarde !== "" && Number.isFinite(getal) && getal >= 1 && getal <= 10 ? getal : null;
}

async function roepGeminiAan(prompt, bericht, apiKey, pogingen) {
  const vandaag = new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam" });
  const vandaagIso = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const volledigePrompt = `${prompt}\n\n---\nVandaag: ${vandaag} (${vandaagIso})\n\nBERICHT\nTitel: ${bericht.titel}\nTekst: ${bericht.samenvatting || "(geen tekst beschikbaar, alleen de titel)"}\nBron: ${bericht.bronNaam}\nURL: ${bericht.url}\nDatum (publicatie, of bij een agenda de datum van het evenement): ${bericht.gepubliceerdOp || "onbekend"}`;

  return roepGeminiAanRuw(volledigePrompt, bericht.bronId, apiKey, pogingen);
}

async function roepGeminiAanRuw(volledigePrompt, bronIdVoorLog, apiKey, pogingen) {
  let laatsteFout;
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      // fetchMetTimeout leest de body binnen de timeout en geeft
      // { response, tekst } terug. JSON.parse doen we hier, zodat een
      // kapotte body ook onder de timeout valt.
      const { response, tekst: ruweTekst } = await fetchMetTimeout(
        GEMINI_URL(apiKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: volledigePrompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
          }),
        },
        25_000
      );

      if (!response.ok) {
        const is429 = response.status === 429;
        const is503 = response.status === 503;
        if ((is429 || is503) && poging < pogingen) {
          const wachttijd = is429 ? 20_000 * poging : 1500 * poging;
          console.warn(`[${bronIdVoorLog}] Gemini HTTP ${response.status} (poging ${poging}/${pogingen}), ${wachttijd / 1000}s wachten...`);
          await nieuweWacht(wachttijd);
          continue;
        }
        throw new Error(`Gemini HTTP ${response.status}`);
      }

      const data = JSON.parse(ruweTekst);
      const tekst = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!tekst) throw new Error("Geen tekst in Gemini-respons");

      const resultaat = JSON.parse(tekst);
      if (!resultaat || typeof resultaat !== "object" || Array.isArray(resultaat)) {
        throw new Error("Gemini gaf geen JSON-object terug");
      }
      return resultaat;
    } catch (fout) {
      laatsteFout = fout;
    }
  }

  console.warn(`[${bronIdVoorLog}] Gemini-aanroep overgeslagen: ${laatsteFout.message}${oorzaakTekst(laatsteFout)}`);
  return null;
}

// ---------------------------------------------------------------------------
// Twee-staps: filter + pitch per bericht
// ---------------------------------------------------------------------------

async function beoordeelMetGemini(bericht, apiKey, pogingen = 3) {
  const isLokaal = bericht.categorie === "lokaal";

  const filterPrompt = isLokaal ? PROMPT_LOKAAL_FILTER : PROMPT_LANDELIJK_FILTER;
  const filterResultaat = await roepGeminiAan(filterPrompt, bericht, apiKey, pogingen);
  if (!filterResultaat) {
    return { ...bericht, aiBeoordeling: null, aiFout: "filter-call mislukt" };
  }

  const oppakbaar = isLokaal ? filterResultaat.oppakbaar : filterResultaat.lokaleInvalshoek;
  if (oppakbaar === "nee") {
    return { ...bericht, aiBeoordeling: filterResultaat, aiFout: null };
  }
  // Bij "twijfel" geen pitch-call: die categorie komt niet in de pitches
  // (alleen "ja" voor lokaal, en "ja" voor landelijk). De pitch-call zou
  // alleen maar API-kosten en 4,5 s vertraging toevoegen.
  if (oppakbaar === "twijfel") {
    return { ...bericht, aiBeoordeling: filterResultaat, aiFout: null };
  }

  await nieuweWacht(PAUZE_TUSSEN_CALLS_MS);

  const pitchPrompt = isLokaal ? PROMPT_LOKAAL_PITCH : PROMPT_LANDELIJK_PITCH;
  const pitchResultaat = await roepGeminiAan(pitchPrompt, bericht, apiKey, pogingen);
  if (!pitchResultaat) {
    return { ...bericht, aiBeoordeling: filterResultaat, aiFout: "pitch-call mislukt" };
  }

  return { ...bericht, aiBeoordeling: { ...filterResultaat, ...pitchResultaat }, aiFout: null };
}

function nieuweWacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beoordeelBerichten(berichten, apiKey, maxAantal = 18, label = "") {
  const teBeoordelen = berichten.slice(0, maxAantal);
  const overgeslagen = berichten.slice(maxAantal).map((b) => ({ ...b, aiBeoordeling: null, aiFout: "dagcap bereikt" }));

  const resultaten = [];
  let teller = 0;
  for (const bericht of teBeoordelen) {
    teller++;
    console.log(`[gemini${label ? " " + label : ""}] beoordeling ${teller}/${teBeoordelen.length}: "${bericht.titel.slice(0, 60)}"`);
    resultaten.push(await beoordeelMetGemini(bericht, apiKey));
    await nieuweWacht(PAUZE_TUSSEN_CALLS_MS);
  }

  const geslaagd = resultaten.filter((r) => r.aiBeoordeling !== null).length;
  console.log(`[gemini${label ? " " + label : ""}] ${geslaagd}/${teBeoordelen.length} beoordelingen geslaagd.`);

  return [...resultaten, ...overgeslagen];
}

// ---------------------------------------------------------------------------
// Derde stap: ranking (één call voor alle pitches samen)
// ---------------------------------------------------------------------------

async function rangschikPitches(berichten, apiKey, pogingen = 3) {
  if (berichten.length === 0) return berichten;

  const teRangschikken = berichten.slice(0, MAX_PITCHES_VOOR_RANKING);
  const buitenBereik = berichten.slice(MAX_PITCHES_VOOR_RANKING);

  const lijst = teRangschikken.map((b, i) => ({
    nr: i + 1,
    titel: b.titel,
    tekst: (b.samenvatting || "").slice(0, 600),
  }));

  const vandaag = new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam" });
  const volledigePrompt = `${PROMPT_RANKING}\n\n---\nVandaag: ${vandaag}\n\nPITCHES\n${JSON.stringify(lijst, null, 2)}`;

  console.log(`[gemini ranking] ${teRangschikken.length} pitch(es) rangschikken in één call...`);
  const resultaat = await roepGeminiAanRuw(volledigePrompt, "ranking", apiKey, pogingen);

  const scoresPerNr = new Map();
  if (resultaat && Array.isArray(resultaat.scores)) {
    for (const item of resultaat.scores) {
      const nr = Number(item && item.nr);
      const score = maakPrioriteit(item && item.score);
      if (Number.isFinite(nr) && score !== null) scoresPerNr.set(nr, score);
    }
  }

  if (scoresPerNr.size === 0) {
    console.warn(`[gemini ranking] Geen bruikbare scores ontvangen; alle pitches krijgen prioriteit null.`);
  }

  const metScore = teRangschikken.map((b, i) => {
    const nr = i + 1;
    const score = scoresPerNr.get(nr) || null;
    return {
      ...b,
      aiBeoordeling: { ...(b.aiBeoordeling || {}), prioriteit: score },
    };
  });

  const zonderScore = buitenBereik.map((b) => ({
    ...b,
    aiBeoordeling: { ...(b.aiBeoordeling || {}), prioriteit: null },
  }));

  console.log(`[gemini ranking] ${scoresPerNr.size} van ${teRangschikken.length} pitch(es) kregen een score.`);
  return [...metScore, ...zonderScore];
}

// ---------------------------------------------------------------------------

/**
 * Fetch met een timeout die de HELE operatie dekt (headers én body). De
 * AbortController wordt pas opgeruimd als de body-read klaar is. Voorheen
 * werd de timeout direct na fetch() gewist en kon een trage body onbeperkt
 * doorlopen.
 *
 * Geeft { response, tekst } terug. De aanroeper parseert de tekst zelf met
 * JSON.parse, zodat de body-read binnen de timeout valt.
 */
async function fetchMetTimeout(url, opties, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...opties, signal: controller.signal });
    const tekst = await response.text();
    return { response, tekst };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { beoordeelBerichten, beoordeelMetGemini, rangschikPitches };
