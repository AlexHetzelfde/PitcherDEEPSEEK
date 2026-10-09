# Nieuwsaggregator Zaanstreek-Waterland

Dagelijkse scraper + AI-pitchmachine voor lokale journalistiek in Zaanstreek-Waterland.
Draait volledig gratis op GitHub Pages + GitHub Actions.

## Hoe het werkt

1. Elke avond om 18:00 (NL-tijd) start een GitHub Actions-workflow.
2. `scraper/index.js` haalt nieuws op van alle bronnen in `scraper/bronnen.js`.
3. Berichten worden geteld. Van elk nieuw bericht wordt de tekst van de
   berichtpagina opgehaald (maximaal ca. 3000 tekens, in het veld `samenvatting`),
   zodat Gemini meer ziet dan een titel; lukt dat niet, dan blijft de tekst uit de
   lijst staan. Daarna worden de berichten gesplitst in een lokale en een
   landelijke lijst, gesorteerd op datum (nieuwste eerst; bij een agenda het
   dichtstbijzijnde evenement eerst).
4. De eerste berichten uit die lijsten (tot een dagcap van standaard 100 per
   lijst) gaan één voor één naar Gemini, met de juiste prompt uit
   `scraper/gemini.js`. Gemini zoekt naar het concrete gevolg voor mensen en
   geeft zelf een prioriteit van 1 tot 10; dat is het enige cijfer in het systeem.
5. De resultaten worden weggeschreven naar `data/*.json`.
6. De workflow committet die JSON-bestanden terug naar de repo.
7. GitHub Pages serveert `index.html`, dat die JSON-bestanden inleest en
   toont — inclusief de top 5 pitches van die dag.

## Eenmalige setup

### 1. Repo op GitHub zetten
Maak een nieuwe (public of private) GitHub-repo aan en push deze hele map
erheen.

### 2. GitHub Pages aanzetten
Ga naar **Settings → Pages** in je repo en zet de bron op **"Deploy from a
branch"**, branch `main`, map `/ (root)`. Na een paar minuten is de site
bereikbaar op `https://<gebruikersnaam>.github.io/<reponaam>/`.

### 3. Gemini API-key aanmaken
Maak een gratis API-key aan via [Google AI Studio](https://aistudio.google.com/apikey)
(inloggen met een Google-account, op "Create API key" klikken).

### 4. Gemini API-key opslaan als GitHub Secret — **hier, en alleen hier**
Dit is de enige veilige plek voor de key. **Zet 'm nooit in een bestand in de
repo zelf** (ook niet in een `.env`-bestand dat je per ongeluk commit) —
alles in een publieke repo is voor iedereen zichtbaar, en zelfs in een
private repo is een los secret veiliger dan een key die in de geschiedenis
van je commits blijft staan.

Zo zet je 'm goed weg:
1. Ga in je GitHub-repo naar **Settings → Secrets and variables → Actions**.
2. Klik op **"New repository secret"**.
3. Naam: `GEMINI_API_KEY`
4. Waarde: plak je Gemini API-key
5. Klik op **"Add secret"**.

GitHub Actions injecteert deze automatisch als omgevingsvariabele in de
workflow (zie `.github/workflows/dagelijkse-run.yml`, regel met
`GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}`). Het script zelf
(`scraper/gemini.js`) leest 'm alleen uit `process.env.GEMINI_API_KEY` — de
key staat dus nergens anders in de code.

Zonder deze secret blijft de scraper gewoon werken; alleen
de AI-beoordeling en de pitches slaan dan over (zie de waarschuwing die
`index.js` in dat geval print).

### 5. Eerste run
Ga naar het tabblad **Actions** in je repo, kies de workflow "Dagelijkse
nieuwsrun" en klik op **"Run workflow"** om 'm handmatig te testen zonder op
18:00 te wachten.

## Bronnen toevoegen
De gewone manier is de workflow **"Bron toevoegen"** (tabblad Actions). Vul de
url van de nieuwspagina in, een korte bron-id en de categorie. Het script zoekt
zelf uit hoe de bron het best opgehaald kan worden. **Gemini is hier altijd voor
nodig** (zonder `GEMINI_API_KEY` stopt het meteen met een duidelijke melding):
Gemini leest als eerste de volledige paginacode en geeft de lijst van alle
berichten die hij ziet. Die lijst is de referentie voor elke methode, die daarna
in deze volgorde wordt geprobeerd: RSS/Atom-feed, WordPress REST API (ook eigen
berichttypes zoals een agenda), JSON-LD (schema.org), generieke HTML-patronen, en
als laatste het recept van Gemini zelf. Gemini geeft ook aan of de pagina een
agenda is, hoe de paginering werkt en waar de tekst per bericht staat.

**Een bron komt alleen in `bronnen.js` als bewezen is dat hij werkt.** Elke
methode draait via dezelfde scraper als de dagelijkse run (`scraper/bron-poort.js`)
en moet berichten opleveren met een echte titel, een unieke link op dezelfde
site en een leesbare datum die niet overal gelijk is. Elke methode moet ook
minstens 80% terugvinden van de berichten die Gemini op de pagina ziet (die lijst
wordt eerst gecontroleerd tegen echte links, dus Gemini kan niets verzinnen). Tot
slot wordt van een steekproef van 5 berichten de berichttekst opgehaald, op
dezelfde manier als in de dagelijkse run: leveren er minder dan 3 bruikbare tekst
(100 tekens of meer), dan valt de bron af. De tekstdekking ("4 van 5 met tekst")
staat in het rapport en in de samenvatting van de run.
Lukt dat niet, dan krijgt Gemini concrete feedback (welke berichten ontbraken,
de HTML eromheen) en probeert hij het opnieuw, maximaal 4 keer, met een sterker
model en vanaf poging 3 met kandidaat-blokken die de code zelf vond. Lukt niets,
dan wordt de workflow rood, verandert er niets aan `bronnen.js` en staat er bij
de run-samenvatting wat er geprobeerd is.

Opties bij het toevoegen:
- **soort**: `auto` (standaard) herkent agenda's zelf, aan vier dingen: het
  adres (agenda, evenement, ...), het oordeel van Gemini, het agenda-venster dat
  de test slaagt, en de datums (de helft of meer in de toekomst, of minstens 5
  en een vijfde: een gemengde lijst met ook afgelopen evenementen). De samenvatting
  zegt waaraan hij is herkend. Kies `agenda` als de datums de datum van het
  evenement zijn (ook zonder jaar, zoals "30 sep"). Zo'n bron krijgt
  `soort: "agenda"` en een eigen venster: van gisteren tot 14 dagen vooruit, in
  plaats van "maximaal 7 dagen oud". Een meerdaags evenement ("30 sep 11 okt")
  bewaart ook een `eindDatum` en telt mee zolang het loopt. Kies je uitdrukkelijk
  `nieuws` terwijl alles op een agenda wijst, dan krijg je een waarschuwing.
- **vervang**: een bestaande bron met hetzelfde id vervangen. Een bron die nu
  niets meer oplevert wordt altijd vervangen, een werkende alleen met deze optie.
- **accepteer twijfel**: alleen nodig als de workflow meldt dat er alleen een
  twijfelachtige kandidaat is (slaagt de poort, maar geen enkel bericht staat
  als link op de pagina). Controleer dan eerst de voorbeelden in de log.

Een bron met maar heel weinig berichten op de pagina krijgt `rustig: true`. De
dagelijkse run meldt "0 na leeftijdsfilter" dan niet als fout. "0 gevonden"
blijft voor elke bron rood.

Dezelfde url mag maar één keer in `bronnen.js` staan (www, een slash aan het
eind en #ankers tellen niet mee): "Bron toevoegen" stopt met een melding die het
bestaande id noemt, en `valideer-bronnen.js` ziet een dubbele als fout.

Na het bewijs telt het script hoeveel berichten vandaag binnen het venster zouden
vallen. Zijn dat er 0, dan staat er een duidelijke waarschuwing in de log en in
de samenvatting. Dat is geen fout (rustige bronnen bestaan), maar controleer dan
of de datums goed gelezen zijn.

### Paginering
Lijstpagina's met meer pagina's worden doorgelezen (`volgPaginas` in
`scraper/hulpmiddelen.js`), voor `gemini-recept`, `generieke-lijst` en de
HTML-terugval van `wordpress-html`. Gemini geeft bij het toevoegen aan hoe de
paginering werkt (`paginering` in `bronnen.js`: een `patroon` met `{n}`, of een
`volgende-link` met een selector); zonder die gegevens wordt alleen gevolgd wat
de pagina zelf aanwijst (`rel="next"` of een link naar pagina 2). Een agenda
wordt doorgelezen tot het laatste evenement op een pagina voorbij het venster
ligt; nieuws tot een pagina een bericht ouder dan 7 dagen bevat. Daarnaast geldt
een harde bovengrens van 10 pagina's per bron per run (`MAX_PAGINAS`) en een
korte pauze tussen pagina's (`PAGINA_PAUZE_MS`). Elke pagina staat in de log, en
een bereikte bovengrens of mislukte pagina wordt gemeld.

### Bronnen die stuk gaan
De dagelijkse run houdt per bron twee tellers bij (`data/bron-gezondheid.json`):
hoeveel runs achter elkaar er niets gevonden is, en hoeveel runs achter elkaar
er niets binnen het venster viel (ook een bron die nog wel berichten vindt maar
waarvan de datums verkeerd gelezen worden, valt zo op). Na twee van die runs
zoekt `scraper/herstel-bronnen.js` opnieuw uit hoe de bron op te halen is; bij
een bron met `rustig: true` pas na 14 runs zonder berichten binnen het venster
(`HERSTEL_MIN_DAGEN_RUSTIG`). Geeft opnieuw uitzoeken dezelfde methode terwijl
er niets binnen het venster valt, dan komt er een issue (rustige bron? datums
fout?) in plaats van stilte. Zoals altijd: het
resultaat komt nooit direct op main: bij succes opent het een **pull request**
met de nieuwe configuratie en het bewijs, anders een **issue** met wat er
geprobeerd is. Je kunt het ook zelf starten met de workflow **"Bron herstellen"**.

Eenmalige repo-instelling: zet onder *Settings > Actions > General* de optie
**"Allow GitHub Actions to create and approve pull requests"** aan. Staat die
uit, dan valt het script terug op een issue en staat de oplossing klaar op de
branch `herstel/<bron-id>`.

### Handmatig in `scraper/bronnen.js`
Kan ook. Geldige `type`s (zie `scraper/scraper-register.js`):
- `"rss"`: een RSS/Atom-feed
- `"wp-rest"`: een WordPress REST API-endpoint (`/wp-json/wp/v2/...`)
- `"json-ld"`: schema.org-gegevens in de pagina zelf
- `"json-api"`: een los JSON-endpoint, met de veldkoppeling in `json`
- `"generieke-lijst"`: bekende HTML-patronen, eerst een feed-link in de pagina
- `"gemini-recept"`: CSS-selectors in `selectors`, meestal door Gemini bedacht
- `"wordpress-html"`: oudere WordPress-scraper (feed, anders HTML)
- `"ibabs"`: `*.bestuurlijkeinformatie.nl`-rapportpagina's

Controleer een wijziging met `node valideer-bronnen.js`. Voor een compleet nieuw
brontype: voeg een bestand toe in `scraper/scrapers/` dat een array van
genormaliseerde berichtobjecten teruggeeft (zie de bestaande scrapers voor het
exacte formaat) en registreer het in `scraper/scraper-register.js`.

## AI-prompts aanpassen
De twee AI-prompts staan in `scraper/gemini.js`. Ze zoeken uitsluitend naar het
concrete gevolg van een bericht voor mensen (wie wordt er geraakt, wat merken ze
ervan) en vragen om een prioriteit van 1 tot 10, waarop de pitches worden
gerangschikt. Pas ze gerust aan naarmate je merkt dat bepaalde signalen beter of
slechter blijken te werken.

## Lokaal testen
```bash
cd scraper
npm install
npx playwright install --with-deps chromium   # eenmalig, voor de iBabs-scraper
GEMINI_API_KEY=jouw-key npm start
```
De output verschijnt in `../data/*.json`. Open daarna `index.html` lokaal in
de browser (of run `python3 -m http.server` in de hoofdmap) om de front-end
te bekijken.
