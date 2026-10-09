// gemini.js
//
// Roept de Gemini API aan met één van de twee prompts hieronder, per bericht.
// Beide prompts zoeken uitsluitend naar het concrete gevolg van een bericht
// voor mensen ("wat betekent dit voor wie?"). Gemini geeft ook de enige
// prioriteit-score van het systeem (1-10), waarop de pitches worden
// gerangschikt. Verwacht de API-key in de
// omgevingsvariabele GEMINI_API_KEY (zie README voor hoe je die als GitHub
// Secret instelt — nooit hardcoded in dit bestand of ergens anders in de repo!).

const { oorzaakTekst } = require("./hulpmiddelen");

const GEMINI_MODEL = "gemini-flash-lite-latest"; // hogere gratis rate-limit dan gewone flash — belangrijk bij tientallen calls per run
const GEMINI_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

const PROMPT_LOKAAL = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één bericht uit een lokale bron (buurtwebsite, schoolwebsite, gemeentelijk
raadsinformatiesysteem, waterschap, provincie, agenda, enzovoort), met de titel en de
tekst van het bericht.

Een pitch uit dit systeem draait UITSLUITEND om deze vraag: wat betekent dit voor [wie],
en welk concreet gevolg heeft het voor een persoon? Denk aan bezuinigingen, uitvallende
bussen, hogere of lagere tarieven, sluitingen, werkzaamheden en omleidingen, nieuwe
regels, geld, tijd, veiligheid of gezondheid van mensen.

Ga zo te werk:
1. Zoek in het bericht naar een gevolg voor mensen: een persoon of groep (bijvoorbeeld
   "reizigers van buslijn 91", "ouders van leerlingen op een vo-school", "huurders in
   Kogerveld") die door het besluit, de maatregel of de gebeurtenis iets merkt in het
   dagelijks leven.
2. Staat zo'n gevolg er niet in, of kun je het alleen bedenken door iets aan te nemen?
   Dan is het antwoord "nee". Een bericht zonder duidelijk gevolg voor mensen (een
   evenement, een uitnodiging, een algemene mededeling, een bestuurlijke procedure, een
   terugblik, een prijs, een persbericht over een organisatie) krijgt "nee", ook als het
   onderwerp interessant is.
3. Geef bij "ja" of "twijfel" aan wie er geraakt wordt en wat het gevolg is.

Geef daarnaast een prioriteit als geheel getal van 1 tot en met 10. Hoger betekent: meer
mensen worden geraakt, het gevolg grijpt dieper in (geld, vervoer, zorg, onderwijs,
wonen, veiligheid), het gaat sneller in en het speelt dichter bij Zaanstreek-Waterland.
Een bericht dat "nee" krijgt, krijgt prioriteit 1.

De datum van vandaag staat onder het bericht. Hoe dichterbij in de tijd het gevolg of de
gebeurtenis ligt, hoe hoger de prioriteit: iets dat vandaag of de komende dagen speelt weegt
zwaarder dan iets dat al voorbij is of pas over weken speelt. Let op: een bericht dat een paar
dagen geleden is geplaatst maar iets aankondigt dat vandaag of binnenkort plaatsvindt, is nu
juist heel relevant. Haal de datum van het gevolg alleen uit de tekst; verzin er geen.

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "oppakbaar": "ja" | "twijfel" | "nee",
  "gevolgenVoor": "wie wordt er geraakt, zo concreet als het bericht toelaat, anders leeg",
  "gevolg": "het concrete gevolg voor die persoon of groep, 1-2 zinnen, alleen wat in het bericht staat of er direct uit volgt, anders leeg",
  "invalshoek": "één zin in de vorm 'Wat betekent dit voor [wie]: ...', alleen als die direct uit de feiten volgt, anders leeg",
  "onderbouwing": "max 3 zinnen: welk feit in het bericht het gevolg draagt, of waarom er geen duidelijk gevolg voor mensen is",
  "teCheckenBronnen": ["bron 1", "bron 2"],
  "prioriteit": 1
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden. Een gevolg telt alleen als het in de tekst
staat of er rechtstreeks uit volgt.`;

const PROMPT_LANDELIJK = `Je bent een redactionele assistent voor een lokale journalist in Zaanstreek-Waterland.
Je krijgt één landelijk nieuwsbericht, met de titel en de tekst van het bericht.
Regionale media kiezen bij landelijk nieuws bijna altijd voor een regionale insteek: ze
"regionaliseren" het onderwerp. In dit systeem doen we dat UITSLUITEND via één vraag: wat
betekent dit voor [wie] in Zaanstreek-Waterland (Zaandam, Zaanstad, Wormerland, Oostzaan,
Purmerend, Edam-Volendam, Waterland), en welk concreet gevolg heeft het voor een persoon?
Denk aan bezuinigingen, uitvallende bussen of treinen, hogere of lagere tarieven,
sluitingen, nieuwe regels, uitkeringen en toeslagen, huren, zorg en onderwijs.

Zoek aanknopingspunten zoals:
- Voert de gemeente dit beleid uit, zodat inwoners van Zaanstad of Purmerend er iets van merken?
- Is er een sector (onderwijs, zorg, ondernemers, woningbouw, landbouw, industrie) of een
  landelijke instelling met een lokale vestiging die door dit nieuws geraakt wordt?
- Gaat het over een groep mensen die ook lokaal woont of werkt (bijvoorbeeld
  arbeidsmigranten, studenten, ouderen, zzp'ers, huurders)?
- Bestaat er een lokale of regionale uitsplitsing van de genoemde cijfers?

Staat er geen duidelijk gevolg voor mensen in het bericht, of kun je het alleen bedenken
door iets aan te nemen? Dan is het antwoord "nee".

Geef daarnaast een prioriteit als geheel getal van 1 tot en met 10. Hoger betekent: meer
mensen in de regio worden geraakt, het gevolg grijpt dieper in, het gaat sneller in en het
is concreter te maken voor Zaanstreek-Waterland. Een bericht dat "nee" krijgt, krijgt
prioriteit 1.

De datum van vandaag staat onder het bericht. Hoe dichterbij in de tijd het gevolg of de
gebeurtenis ligt, hoe hoger de prioriteit: iets dat vandaag of de komende dagen speelt weegt
zwaarder dan iets dat al voorbij is of pas over weken speelt. Let op: een bericht dat een paar
dagen geleden is geplaatst maar iets aankondigt dat vandaag of binnenkort plaatsvindt, is nu
juist heel relevant. Haal de datum van het gevolg alleen uit de tekst; verzin er geen.

Als je een "ja" of "twijfel" geeft, werk de pitch dan verder uit: een voorgestelde
kop, een korte uitleg van het gevolg voor de betrokken mensen (2-4 zinnen), en concrete
vervolgstappen voor de journalist — wie te interviewen of welke lokale
instantie te bellen, en welke feiten nog gecheckt moeten worden voordat dit
gepubliceerd kan worden. Dat laatste is niet optioneel: een journalist mag een
gesuggereerde invalshoek nooit ongecheckt overnemen, en moet altijd
hoor-wederhoor toepassen bij de partijen die het aangaat.

Geef ALLEEN geldig JSON terug, in dit exacte formaat, zonder markdown-fences of andere tekst:
{
  "lokaleInvalshoek": "ja" | "twijfel" | "nee",
  "gevolgenVoor": "wie in Zaanstreek-Waterland wordt er geraakt, zo concreet als het bericht toelaat, anders leeg",
  "gevolg": "het concrete gevolg voor die persoon of groep, 1-2 zinnen, alleen wat in het bericht staat of er direct uit volgt, anders leeg",
  "aanleiding": "concrete, controleerbare aanleiding die logisch uit het bericht volgt, anders leeg",
  "voorgesteldeKop": "een pakkende, feitelijk onderbouwde kop voor het lokale artikel, anders leeg",
  "pitchUitleg": "2-4 zinnen die het gevolg voor de betrokken mensen uitwerken tot een bruikbare pitch, anders leeg",
  "vervolgstappen": ["concrete actie 1, bijv. wie te interviewen", "concrete actie 2, bijv. welk feit te checken"],
  "onderbouwing": "bij twijfel/nee: waarom er geen onderbouwd gevolg voor mensen te vinden is",
  "prioriteit": 1
}

Blijf strikt bij wat feitelijk in het bericht staat. Doe geen aannames over motieven,
gevolgen of context die niet genoemd worden. Doe nooit een aanname om tot een invalshoek
te komen. Een journalist moet elke gesuggereerde invalshoek nog zelf kunnen checken met
feiten en hoor-wederhoor. Als je geen concreet aanknopingspunt hebt, zeg dat expliciet —
verzin er geen bij, en laat gevolgenVoor, gevolg, voorgesteldeKop, pitchUitleg en
vervolgstappen dan leeg.`;

/**
 * Zet de prioriteit uit Gemini's antwoord om naar een geheel getal van 1 tot
 * en met 10, of null als het antwoord geen bruikbaar cijfer bevat (ontbreekt,
 * tekst, buiten 1-10). index.js behandelt null als "geen prioriteit" en meldt dat.
 */
function maakPrioriteit(waarde) {
  const getal = Math.round(Number(waarde));
  return waarde !== null && waarde !== "" && Number.isFinite(getal) && getal >= 1 && getal <= 10 ? getal : null;
}

/**
 * Beoordeelt één bericht met Gemini. Faalt een call (timeout, rate limit,
 * ongeldige JSON-response), dan wordt het bericht overgeslagen voor deze run
 * in plaats van de hele batch te laten crashen — zoals besproken: liever één
 * gemiste pitch dan een mislukte dagelijkse cyclus.
 */
async function beoordeelMetGemini(bericht, apiKey, pogingen = 3) {
  const prompt = bericht.categorie === "lokaal" ? PROMPT_LOKAAL : PROMPT_LANDELIJK;
  // De datum van vandaag (Nederlandse tijd), zodat Gemini kan wegen hoe dichtbij iets speelt.
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
        // 503 = tijdelijke serveroverbelasting bij Google, lost vaak binnen
        // een paar seconden op. 429 = je zit over de rate-limit-venster van
        // het gratis tier (~10-15 aanvragen/minuut) — dat venster is grofweg
        // een minuut, dus daar helpt een paar seconden wachten niets; die
        // krijgt een veel langere back-off.
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

      const beoordeling = JSON.parse(tekst);
      if (!beoordeling || typeof beoordeling !== "object" || Array.isArray(beoordeling)) {
        throw new Error("Gemini gaf geen JSON-object terug");
      }
      beoordeling.prioriteit = maakPrioriteit(beoordeling.prioriteit);
      return { ...bericht, aiBeoordeling: beoordeling, aiFout: null };
    } catch (fout) {
      laatsteFout = fout;
    }
  }

  console.warn(`[${bericht.bronId}] Gemini-beoordeling overgeslagen: ${laatsteFout.message}${oorzaakTekst(laatsteFout)}`);
  return { ...bericht, aiBeoordeling: null, aiFout: laatsteFout.message };
}

function nieuweWacht(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Beoordeelt een lijst berichten na elkaar (niet parallel — dat voorkomt dat
 * we in één keer tegen rate limits aanlopen). `maxAantal` is de dagcap: bij
 * veel berichten worden alleen de eerste `maxAantal` (de lijst moet dus al
 * gesorteerd zijn op datum, dichtstbijzijnde eerst) daadwerkelijk naar Gemini
 * gestuurd.
 *
 * Tussen elke aanroep zit een vaste pauze (PAUZE_TUSSEN_CALLS_MS) zodat we
 * structureel onder de gratis-tier rate-limit (~10-15 aanvragen/minuut)
 * blijven, in plaats van er telkens tegenaan te lopen en daarna te moeten
 * herstellen met een lange back-off — dat laatste kostte de vorige run bijna
 * 10 minuten voor uiteindelijk 0 geslaagde beoordelingen.
 */
const PAUZE_TUSSEN_CALLS_MS = 4500; // ~13 aanvragen/minuut, ruim onder de gratis-tier-limiet

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
