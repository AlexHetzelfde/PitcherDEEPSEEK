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

const GEMINI_MODEL = "gemini-flash-lite-latest"; // hogere gratis rate-limit dan gewone flash — belangrijk bij tientallen calls per run
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

// Pauze tussen twee Gemini-calls (ongeacht of dat tussen filter en pitch is,
// of tussen twee berichten). 4,5 seconde komt neer op ~13 aanvragen/minuut,
// ruim onder de gratis-tier-limiet van ~15/minuut. Bewust hier bovenaan,
// zodat zowel beoordeelMetGemini als beoordeelBerichten hem kan gebruiken.
const PAUZE_TUSSEN_CALLS_MS = 4500;

// ---------------------------------------------------------------------------
// Call 1: filter. Bepaalt of het bericht oppakbaar is (lokaal) of een lokale
// invalshoek heeft (landelijk). Géén pitch, géén score — dat is call 2.
// ---------------------------------------------------------------------------

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

Blijf strikt bij wat feitelijk in het
