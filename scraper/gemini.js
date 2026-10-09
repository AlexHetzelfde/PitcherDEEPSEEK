// gemini.js
//
// Roept de Gemini API aan in TWEE stappen per bericht:
//
//   Call 1 (filter): bepaalt of het bericht oppakbaar is. Voor lokale
//     berichten heet dat "oppakbaar" (ja/twijfel/nee), voor landelijke
//     "lokaleInvalshoek". Een simpele classificatie: heeft dit bericht een
//     concreet gevolg voor mensen in hun dagelijks leven?
//
//   Call 2 (pitch): alleen voor berichten die door de filter komen. Maakt de
//     pitch (wie wordt geraakt, wat is het gevolg, wat is een goede invalshoek)
//     en geeft de prioriteit (1-10).
//
// Waarom twee calls: één call die vier dingen tegelijk moet doen (filteren,
// gevolg beschrijven, pitch maken, prioriteit geven) geeft elk van die taken
// minder aandacht. Door te splitsen krijgt elke taak een gerichte prompt. De
// filter is bovendien een stuk goedkoper dan de pitch, en de meeste berichten
// vallen in de filter af: die kosten dan maar één call in plaats van twee.
//
// Verwacht de API-key in de omgevingsvariabele GEMINI_API_KEY (zie README
// voor hoe je die als GitHub Secret instelt — nooit hardcoded in dit bestand
// of ergens anders in de repo!).

const { oorzaakTekst } = require("./hulpmiddelen");

const GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const PAUZE_TUSSEN_CALLS_MS = 4500;

const PROMPT_LOKAAL_FILTER = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één bericht uit een lokale bron (buurtwebsite, schoolwebsite, gemeentelijk
raadsinformatiesysteem, waterschap, provincie, agenda, enzovoort), met de titel en de
tekst van het bericht.

Jouw enige taak: bepaal of dit bericht interessant genoeg is om op te pakken. Een
bericht is oppakbaar als het een concreet gevolg heeft voor mensen in hun dagelijks
leven. Denk aan bezuinigingen, uitvallende bussen, hogere of lagere tarieven,
sluitingen, werkzaamheden en omleidingen, nieuwe regels, geld, tijd, veiligheid of
gezondheid.

Een evenement, een uitnodiging, een algemene mededeling, een bestuurlijke procedure,
een terugblik, een prijs of een persbericht over een organisatie krijgt "nee", ook als
het onderwerp interessant is. Een gevolg telt alleen als het in de tekst staat of er
rechtstreeks uit volgt.

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "oppakbaar": "ja" | "twijfel" | "nee",
  "onderbouwing": "max 2 zinnen: welk feit in het bericht het gevolg draagt, of waarom er geen duidelijk gevolg voor mensen is"
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden.`;

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

const PROMPT_LOKAAL_PITCH = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één bericht uit een lokale bron dat al als oppakbaar is beoordeeld. Maak nu
de pitch: wie wordt er geraakt, wat is het concrete gevolg, en wat is een goede
invalshoek?

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "gevolgenVoor": "wie wordt er geraakt, zo concreet als het bericht toelaat, anders leeg",
  "gevolg": "het concrete gevolg voor die persoon of groep, 1-2 zinnen, alleen wat in het bericht staat of er direct uit volgt, anders leeg",
  "invalshoek": "één zin in de vorm 'Wat betekent dit voor [wie]: ...', alleen als die direct uit de feiten volgt, anders leeg",
  "teCheckenBronnen": ["bron 1", "bron 2"],
  "prioriteit": 1
}

Geef daarnaast een prioriteit als geheel getal van 1 tot en met 10. Hoger betekent: meer
mensen worden geraakt, het gevolg grijpt dieper in (geld, vervoer, zorg, onderwijs,
wonen, veiligheid), het gaat sneller in en het speelt dichter bij Zaanstreek-Waterland.

De datum van vandaag staat onder het bericht. Hoe dichterbij in de tijd het gevolg of de
gebeurtenis ligt, hoe hoger de prioriteit: iets dat vandaag of de komende dagen speelt
weegt zwaarder dan iets dat al voorbij is of pas over weken speelt. Let op: een bericht
dat een paar dagen geleden is geplaatst maar iets aankondigt dat vandaag of binnenkort
plaatsvindt, is nu juist heel relevant. Haal de datum van het gevolg alleen uit de tekst;
verzin er geen.

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden.`;

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
  "vervolgstappen": ["concrete actie 1, bijv. wie te interviewen", "concrete actie 2, bijv. welk feit te checken"],
  "prioriteit": 1
}

Geef daarnaast een prioriteit als geheel getal van 1 tot en met 10. Hoger betekent: meer
mensen in de regio worden geraakt, het gevolg grijpt dieper in, het gaat sneller in en
het is concreter te maken voor Zaanstreek-Waterland.

De datum van vandaag staat onder het bericht. Hoe dichterbij in de tijd het gevolg of de
gebeurtenis ligt, hoe hoger de prioriteit: iets dat vandaag of de komende dagen speelt
weegt zwaarder dan iets dat al voorbij is of pas over weken speelt. Haal de datum van het
gevolg alleen uit de tekst; verzin er geen.

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden.`;

function maakPrioriteit(waarde) {
  const getal = Math.round(Number(waarde));
  return waarde !== null && waarde !== "" && Number.isFinite(getal) && getal >= 1 && getal <= 10 ? getal : null;
}

async function roepGeminiAan(prompt, bericht, apiKey, pogingen) {
  const vandaag = new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam" });
  const vandaagIso = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
  const volledigePrompt = `${prompt}\n\n---\nVandaag: ${vandaag} (${vandaagIso})\n\nBERICHT\nTitel: ${bericht.titel}\nTekst: ${bericht.samenvatting || "(geen tekst beschikbaar, alleen de titel)"}\nBron: ${bericht.bronNaam}\nURL: ${bericht.url}\nDatum (publicatie, of bij een agenda de datum van het evenement): ${bericht.gepubliceerdOp || "onbekend"}`;

  let laatsteFout;
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      const response = await fetchMetTimeout(
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
          console.warn(`[${bericht.bronId}] Gemini HTTP ${response.status} (poging ${poging}/${pogingen}), ${wachttijd / 1000}s wachten...`);
          await nieuweWacht(wachttijd);
          continue;
        }
        throw new Error(`Gemini HTTP ${response.status}`);
      }

      const data = await response.json();
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

  console.warn(`[${bericht.bronId}] Gemini-aanroep overgeslagen: ${laatsteFout.message}${oorzaakTekst(laatsteFout)}`);
  return null;
}

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

  await nieuweWacht(PAUZE_TUSSEN_CALLS_MS);

  const pitchPrompt = isLokaal ? PROMPT_LOKAAL_PITCH : PROMPT_LANDELIJK_PITCH;
  const pitchResultaat = await roepGeminiAan(pitchPrompt, bericht, apiKey, pogingen);
  if (!pitchResultaat) {
    return { ...bericht, aiBeoordeling: { ...filterResultaat, prioriteit: null }, aiFout: "pitch-call mislukt" };
  }

  const gecombineerd = { ...filterResultaat, ...pitchResultaat };
  gecombineerd.prioriteit = maakPrioriteit(gecombineerd.prioriteit);
  return { ...bericht, aiBeoordeling: gecombineerd, aiFout: null };
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

async function fetchMetTimeout(url, opties, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opties, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { beoordeelBerichten, beoordeelMetGemini };
