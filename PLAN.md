# PLAN.md: ZANP verbeteringen

Bron van waarheid voor alle chats. Elke chat begint met: clone de repo, lees dit bestand, doe alleen de genoemde fase. Werk dit bestand aan het eind van elke chat bij.

Status: `[ ]` open, `[x]` af, `[~]` deels (zie opmerking).

## Spelregels (gelden voor elke fase)

1. Het pitchdeel blijft onaangeroerd. We werken alleen aan ZANP.
2. Pitches draaien dagelijks op Gemini Flash.
3. Alles van ZANP draait op Gemini Flash-Lite en mag nooit het Flash-quotum gebruiken.
4. Alleen fouten oplossen en de gevraagde verbeteringen doorvoeren. Wat werkt of goed is, blijft zoals het is.

### Niet aanraken (pitchdeel)

- `scraper/index.js`
- `.github/workflows/dagelijkse-run.yml`
- `data/pitches.json`, `data/nieuws-lokaal.json`, `data/nieuws-landelijk.json`, `data/feed.json`, `data/bron-gezondheid.json`
- `scraper/nieuwscriteria.js`
- Het pitchgedrag van `gemini.js` en `gedeeld.js`: wijzigingen daar zijn alleen toegestaan als optionele instelling of aparte functie voor ZANP, met standaardgedrag identiek aan nu. Na zo'n wijziging controleren dat de pitchuitvoer ongewijzigd blijft.

### Eerste controle in de repo, voor elke fase

Dit plan is opgesteld uit het chatgesprek, niet uit de actuele repo. Controleer eerst de actuele staat van de bestanden hieronder. Het gesprek meldt dat Flash-Lite voor ZANP en een stop bij een 429 in `zanp.js` mogelijk al (deels) staan.

---

## Fase 1: AI-laag en quotum

Doel: ZANP werkt binnen een klein dagquotum en ook zonder AI.
Verwachte bestanden: `scraper/gemini.js`, `scraper/zanp.js`, `scraper/wire.js`, `scraper/alert-regels.js`, `.github/workflows/zanp-run.yml`, `data/zanp-status.json` (gegenereerd).

Fouten uit de eerste run:
- [ ] AI-aanroepen mislukten met een 429: het gratis quotum was 20 verzoeken per dag, niet 150 of 80.
- [ ] De teller telde pogingen in plaats van successen (32 bij een grens van 20). Na de eerste 429 gingen er nog zeven zinloze aanroepen af.
- [ ] Van 84 berichten hadden er maar 4 een checklist. Alerts en agendapunten uit berichten zijn dus ongetest en 61 berichten zijn nooit geanalyseerd.

Verbeteringen:
- [ ] ZANP overal op Flash-Lite zetten (eerst controleren wat er al staat in `zanp.js`).
- [ ] Batchen: meerdere berichten in één verzoek, voor meldingen, analyses en de dubbel-nieuws-vragen. Elk bericht in een batch wordt apart gecontroleerd; een gedeeltelijk antwoord blijft bruikbaar.
- [ ] Stroomonderbreker: bij de eerste 429 stopt de run met AI, de wachttijd komt in `zanp-status.json`, volgende runs slaan AI over tot die tijd.
- [ ] Alleen geslaagde verzoeken tellen mee. De quotumdag volgt de Amerikaanse middernacht.
- [ ] Prioriteit: eerst signaalberichten en officiële berichten met prio 3 of hoger, routine pas als er ruimte over is.
- [ ] Zonder AI moet ZANP volledig werken:
  - [ ] een eerste checklist via patronen
  - [ ] agendapunten via trefwoorden plus datum
  - [ ] (de tag via trefwoorden volgt in Fase 3)
- [ ] De AI verfijnt alleen.
- [ ] `ZANP_DAGCAP` en `ZANP_RUNCAP` instellen op basis van de echte Flash-Lite-limiet in AI Studio (https://ai.dev/rate-limit).

Afronding: ZANP-workflow handmatig starten met "alles" aan, log van STAP 2 en 5 lezen, controleren dat de pitchbestanden ongewijzigd zijn.

---

## Fase 2: Scraper, agenda en timing

Doel: sneller scrapen en een agenda die twee weken vooruit kijkt.
Verwachte bestanden: `scraper/gedeeld.js`, `scraper/zanp.js`, `scraper/agenda-regels.js`, `.github/workflows/zanp-run.yml`.

Fouten uit de eerste run:
- [ ] Bronnen worden één voor één afgewerkt.
- [ ] De Waarheen-agenda reikt maar tot 30 oktober, omdat de scraper stopt zodra een pagina na vandaag begint. De weekagenda is vanaf ongeveer vrijdag leeg.
- [ ] Het jubileumfilter mist "Tentoonstelling 150 jaar Noordzeekanaal".
- [ ] De cron is onbetrouwbaar: drie runs in ruim vier uur, waarschijnlijk was er maar één gepland.

Verbeteringen:
- [ ] Bronnen parallel ophalen (ongeveer vier tegelijk), met een maximumtijd van ongeveer 45 seconden per bron.
- [ ] Agendahorizon voor ZANP naar twee weken vooruit. Dit is een optionele instelling in de gedeelde scrapecode; de pitchrun houdt zijn huidige gedrag (alleen de dag zelf en de dag ervoor).
- [ ] Jubileumjaren toevoegen: 10, 20, 30 jaar enzovoort.
- [ ] Leeftijden zoals "4-10 jaar" blijven uitgesloten.
- [ ] "150 jaar Noordzeekanaal" moet door het filter komen.
- [ ] Externe timer (gratis cron-dienst) die de workflow elke 30 minuten start, met de GitHub-cron als reserve. Vraagt een token van jou.

Afronding: handmatige run, controleren dat de agenda ruim voorbij 30 oktober loopt en dat de pitchuitvoer ongewijzigd is.

---

## Fase 3: Tags, Bron toevoegen en layout

Doel: onderwerpindeling in negen tags en een slankere ANP-achtige weergave.
Verwachte bestanden: `scraper/wire.js`, `scraper/gemini.js` (alleen ZANP-deel), `scraper/rubrieken.js`, `scraper/rubrieken.json`, `scraper/voeg-bron-toe.js`, `scraper/valideer-rubrieken.js`, `.github/workflows/bron-toevoegen.yml`, `index.html`, `script.js`, `style.css`.

Fout uit de eerste run:
- [ ] 54 berichten staan in de kolom "Lokaal nieuws". Je wilde een onderwerpindeling.

### Tags (negen)

- [ ] Lijst: cultuur, gemeente, provincie, recht, bedrijven, 112, sport, verkeer, onderwijs.
- [ ] Onderwijs is voor Blaise Pascal College en OVO.
- [ ] De AI kiest per bericht één tag uit de gesloten lijst, in dezelfde batch.
- [ ] Zonder AI kiest een trefwoordenlijst, en bij geen treffer de standaardtag van de bron.
- [ ] Standaardtags per bron:
  - gemeente: bekendmakingen, regelgeving, hoorzittingen
  - recht: rechtspraak
  - provincie: nh-actueel, waterschap, omgevingsdiensten
  - cultuur: museum, molen, Zaanse Schans, Cultuurhuis, Waarheen, nh-cultuur
  - onderwijs: Blaise Pascal College, OVO
- [ ] Een bericht zonder passende tag staat alleen in "ZANP totaal".
- [ ] Lege kolommen (112, sport, verkeer, bedrijven) worden verborgen.
- [ ] Oude records houden hun oude code en vallen terug op alleen het totaal.
- [ ] Agendapunten uit berichten erven de tag van hun bericht.
- [ ] "Bron toevoegen": bij een nieuwe bron kies je zelf een tag. De lijst in `bron-toevoegen.yml` wordt bijgewerkt (inclusief onderwijs), en `rubrieken.json` en `valideer-rubrieken.js` kennen de nieuwe tag.

### Layout (zelfde opzet, slanker, meer ANP)

- [ ] Slanke witte bovenbalk van ongeveer 40 px: klein ZANP-woordmerk, tabs Nieuws, Agenda en Pitches, een stipje voor de laatste update en een ⋮-menu voor kolommen. Een waarschuwing verschijnt alleen als de stroom verouderd is.
- [ ] Kolommen smaller (ongeveer 220 px), kleinere letter, krappere regels.
- [ ] Per kolom alleen een titel, een zoekicoon en de agendabalk.
- [ ] Alert als rode rij in de stroom (oranje voor "mogelijk groot"), niet als aparte balk bovenaan.
- [ ] Eruit halen: werkbalk met filters, uitlegtekst, dagkoppen in de kolommen, berichtenteller per kolom, chips in de lijst.
- [ ] "Ook gemeld door" en de agendakoppeling komen alleen nog in het uitgeklapte bericht.
- [ ] Agenda: alleen ‹ Vandaag › met weeklabel en zeven dagkolommen. Dagbalk, datumkiezer en de knop "Toon ook gefilterde items" vervallen. Gefilterde items zijn alleen nog te zien via `#agenda?alles=1`.
- [ ] Klein rond "T"-icoon bij agendapunten die aan een bericht hangen.
- [ ] Op de telefoon staan de zeven dagen onder elkaar.

Afronding: handmatige run, daarna de site in een echte browser controleren (tot nu toe alleen in jsdom getest).

---

## Backlog (nog niet ingepland)

Pas oppakken na Fase 3, per stuk beslissen.

- [ ] Nieuwe bronnen: politie, brandweer en 112, verkeer, sport, bedrijven, gemeentenieuws, gemeenten buiten Zaanstad. Eerst per bron uitzoeken welke open feeds bestaan.
- [ ] Koppeling op harde sleutels (adres, zaaknummer, ECLI, postcode).
- [ ] Agendapunt dat na de zitting naar het resultaat linkt.
- [ ] Kwaliteitslog van AI-afkeuringen over meerdere dagen.
- [ ] Tests in de repo (`scraper/tests/` plus een stap in `controle.yml`).
- [ ] Echte live-meldingen met push of geluid.
- [ ] Getallen als woord ("twee gewonden") herkennen voor alerts.
- [ ] Termijnen buiten het agendavenster beter zichtbaar maken.

---

## Startprompt per fase

> Clone https://github.com/AlexHetzelfde/PitcherDEEPSEEK en lees `PLAN.md`. We doen alleen **Fase N**. Raak het pitchdeel niet aan (zie "Niet aanraken" in `PLAN.md`). Wijzig niets wat werkt. Controleer eerst de actuele staat van de bestanden van deze fase. Bouw, test, en geef alleen de gewijzigde bestanden terug. Werk daarna `PLAN.md` bij met wat af is en wat open staat.

## Voortgang

- Fase 1: open
- Fase 2: open
- Fase 3: open
