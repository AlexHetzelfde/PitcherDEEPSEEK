// bronnen.js
//
// Centrale lijst van bronnen. Elke bron krijgt een categorie: "lokaal" of "landelijk".
// Voeg hier nieuwe bronnen toe zodra je er meer wilt scrapen — de rest van de
// pipeline (AI-beoordeling, front-end) werkt automatisch mee.
//
// Sinds de "schone tekst"-ronde (2026-10-13) mogen bronnen een optioneel
// veld "detailSelector" hebben: een CSS-selector die op de detailpagina als
// eerste wordt geprobeerd.
//
// Sinds de "evenementdatum"-ronde (2026-10-14):
//  - zaansche-molen, ovo-zaanstad en blaise-pascal-college hebben rustig: true.
//  - zaanstad-hoorzittingen heeft soort: "agenda".
//  - zaans-cultuur-huis is gemini-recept met soort: "agenda" en gebruikt
//    time.event-date (datetime-attribuut) als datum.
//  - hhnk-actueel en pascal-zuid zijn verwijderd.
//
// Sinds de "rustige-bronnen-en-rechtspraak"-ronde (2026-10-15):
//  - zaans-museum, zaanse-schans, omgevingsdienstnoordzeekanaal,
//    OmgevingsdienstNHN en zaandijk-leeft hebben rustig: true gekregen.
//  - rechtspraak-noord-holland toegevoegd: de RSS-feed van de Rechtbank
//    Noord-Holland.
//
// Sinds de "eerlijke-pipeline"-ronde (2026-10-15):
//  - ibabs-collegeberichten en ibabs-ingekomen-stukken hebben rustig: true
//    gekregen. De iBabs-scraper gooit zelf berichten buiten het venster weg,
//    dus een rustige periode gaf "0 berichten" en daarmee een herstel-issue.
//  - De vijf bronnen die "naam" gelijk hadden aan hun "id" (hhnk,
//    zaandijk-leeft, OmgevingsdienstNHN, omgevingsdienstnoordzeekanaal,
//    WaarheenAgenda) hebben een leesbare naam gekregen. De oude namen staan
//    in FEED_BRON_ALIASSEN in index.js.
//
// Sinds de "rechtspraak-filter"-ronde (2026-10-15):
//  - De rechtspraak-feed krijgt een filterTermen-veld. De RSS van de
//    Rechtbank Noord-Holland bevat alle uitspraken uit de hele provincie
//    (Haarlem, Alkmaar, Schiphol, Den Helder, Hoorn, ...). Zonder filter
//    domineren die de dagelijkse run en de feed met tientallen niet-Zaanse
//    zaken. Met filterTermen komen alleen uitspraken door waarin een
//    Zaanstreek-Waterlandse plaatsnaam voorkomt (in titel of samenvatting).

module.exports = [
  {
    id: "zaansche-molen",
    naam: "De Zaansche Molen — Nieuws",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://www.zaanschemolen.nl/nieuws/",
    rustig: true,
  },
  {
    id: "ibabs-collegeberichten",
    naam: "Zaanstad — Collegeberichten (iBabs)",
    categorie: "lokaal",
    type: "ibabs",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/8ea04074-52e6-4284-bd1a-66e378b40ec1",
    rustig: true,
  },
  {
    id: "ibabs-ingekomen-stukken",
    naam: "Zaanstad — Ingekomen stukken (iBabs)",
    categorie: "lokaal",
    type: "ibabs",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/58e397b1-0b36-49e2-90ed-325405f27f72",
    rustig: true,
  },
  {
    id: "ovo-zaanstad",
    naam: "OVO Zaanstad (koepel 7 vo-scholen)",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.ovo-zaanstad.nl/nieuws/",
    rustig: true,
  },
  {
    id: "blaise-pascal-college",
    naam: "Blaise Pascal College",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.blaisepascalcollege.nl/",
    rustig: true,
  },
  {
    id: "zaans-museum",
    naam: "Zaans Museum — Nieuws & Pers",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://zaansmuseum.nl/nieuws-pers/",
    rustig: true,
  },
  {
    id: "zaanse-schans",
    naam: "Zaanse Schans — Actueel",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.dezaanseschans.nl/contact/actueel/",
    rustig: true,
  },
  {
    id: "nh-actueel",
    naam: "Provincie Noord-Holland — Actueel",
    categorie: "lokaal",
    type: "rss",
    url: "https://www.noord-holland.nl/pnhnieuws",
  },
  {
    id: "nh-cultuur",
    naam: "Provincie Noord-Holland — Cultuur en Erfgoed",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.noord-holland.nl/Onderwerpen/Cultuur_en_Erfgoed",
  },
  {
    id: "zaanstad-hoorzittingen",
    naam: "Zaanstad — Hoorzittingen",
    categorie: "lokaal",
    type: "gemini-recept",
    url: "https://loket.zaanstad.nl/mozard/!suite16.scherm1168?mGmr=2168",
    soort: "agenda",
    detailSelector: ".aandachtstekst__tekst",
    selectors: {
      itemSelector: ".zaakregel",
      titelSelector: "h3",
      linkSelector: "a.zaakregel__verwijzing",
      datumSelector: null,
      datumAttribuut: null,
      samenvattingSelector: "#me_CBCzqv, .aandachtstekst__tekst, .zaakregel__omschrijving, .zaakregel p",
    },
  },
  {
    id: "zaandijk-leeft",
    naam: "Zaandijk Leeft!",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://zaandijkleeft.nl/",
    rustig: true,
  },
  {
    id: "OmgevingsdienstNHN",
    naam: "Omgevingsdienst Noord-Holland Noord",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.odnhn.nl/Menu/Over_ons/Nieuws/2022",
    rustig: true,
  },
  {
    id: "omgevingsdienstnoordzeekanaal",
    naam: "Omgevingsdienst Noordzeekanaalgebied",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://odnzkg.nl/nieuws/",
    rustig: true,
  },
  {
    id: "zaans-cultuur-huis",
    naam: "Zaans Cultuurhuis — Agenda",
    categorie: "lokaal",
    type: "gemini-recept",
    url: "https://zaanscultuurhuis.nl/agenda",
    soort: "agenda",
    selectors: {
      itemSelector: "article.eventlist-event--upcoming",
      titelSelector: "h1.eventlist-title",
      linkSelector: "a.eventlist-title-link",
      datumSelector: "time.event-date",
      datumAttribuut: "datetime",
      samenvattingSelector: ".eventlist-excerpt",
      fotoSelector: "a.eventlist-column-thumbnail img",
      fotoAttribuut: "data-src",
    },
  },
  {
    id: "WaarheenAgenda",
    naam: "Waarheen Agenda (De Orkaan)",
    categorie: "lokaal",
    type: "gemini-recept",
    url: "https://waarheen.deorkaan.nl/agenda/",
    soort: "agenda",
    detailSelector: ".text-content-section",
    selectors: {
      itemSelector: "a.event-card",
      titelSelector: "h2",
      linkSelector: "self",
      datumSelector: ".date",
      datumAttribuut: null,
    },
  },
  {
    id: "hhnk",
    naam: "Hoogheemraadschap Hollands Noorderkwartier — Nieuws",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.hhnk.nl/nieuws",
  },
  {
    id: "rechtspraak-noord-holland",
    naam: "Rechtspraak — Rechtbank Noord-Holland",
    categorie: "lokaal",
    type: "rss",
    url: "https://uitspraken.rechtspraak.nl/rss/?instantie=http%3A%2F%2Fstandaarden.overheid.nl%2Fowms%2Fterms%2FRechtbank_Noord-Holland&instantietype=2",
    // De rechtbank-feed bevat uitspraken uit heel Noord-Holland (Haarlem,
    // Alkmaar, Schiphol, Den Helder, Hoorn, ...). Alleen uitspraken waarin
    // een Zaanstreek-Waterlandse plaatsnaam voorkomt zijn voor deze
    // pipeline interessant. De filter draait op titel + samenvatting,
    // case-insensitive, en slaat aan zodra één term voorkomt. Toegepast in
    // index.js (scrapeAlleBronnen), vóór de agenda-afleiding en vóór de
    // feed, dus weggefilterde berichten komen nergens meer in.
    filterTermen: [
      // Zaanstreek
      "Zaanstad",
      "Zaandam",
      "Zaandijk",
      "Koog aan de Zaan",
      "Wormerveer",
      "Krommenie",
      "Assendelft",
      "Westzaan",
      "Wormer",
      "Wijdewormer",
      "Jisp",
      "Neck",
      "Oostknollendam",
      "Spijkerboor",
      "Oostzaan",
      // Waterland
      "Landsmeer",
      "Den Ilp",
      "Watergang",
      "Purmerend",
      "Edam",
      "Volendam",
      "Monnickendam",
      "Marken",
      "Katwoude",
      "Ilpendam",
      "Broek in Waterland",
      "Zuiderwoude",
      "Uitdam",
      "Middelie",
      "Warder",
      "Beets",
      "Hobrede",
      "Kwadijk",
      "Oosthuizen",
      "Schardam",
      // Regio (vangt zaken die geen specifieke plaats noemen)
      "Zaanstreek",
      "Waterland",
    ],
    rustig: true,
  },
  {
    id: "Bekendmakingen",
    naam: "Bekendmakingen",
    categorie: "lokaal",
    type: "rss",
    url: "https://zoek.officielebekendmakingen.nl/rss?q=(c.product-area==%22officielepublicaties%22)and(dt.creator==%22Zaanstad%22)and((dt.type==%22algemeen%20verbindend%20voorschrift%20(ministeri%C3%ABle%20regeling)%22)or(dt.type==%22algemeen%20verbindend%20voorschrift%20(verordening)%22)or(dt.type==%22algemeenverbindendverklaring%20van%20cao-bepalingen%22)or(dt.type==%22ander%20besluit%20van%20algemene%20strekking%22)or(dt.type==%22bekendmaking%20aan%20de%20scheepvaart%22)or(dt.type==%22beleidsregel%22)or(dt.type==%22delegatie-%20of%20mandaatbesluit%22)or(dt.type==%22gemeenschappelijke%20regeling%22)or(dt.type==%22ruimtelijk%20plan%20of%20omgevingsdocument%22)or(dt.type==%22verkeersbesluit%20of%20-mededeling%22)or(dt.type==%22andere%20melding%22)or(dt.type==%22evenementmelding%22)or(dt.type==%22exploitatiemelding%22)or(dt.type==%22melding%20van%20activiteiten%20op%20of%20in%20oppervlaktewater%22)or(dt.type==%22omgevingsmelding%22)or(dt.type==%22benoeming%20of%20ontslag%22)or(dt.type==%22circulaire%22)or(dt.type==%22convenant%22)or(dt.type==%22interne%20regeling%22)or(dt.type==%22kieswetpublicatie%22)or(dt.type==%22koninklijke%20onderscheiding%22)or(dt.type==%22mededeling%20verzekeringswezen%22)or(dt.type==%22onteigening%22)or(dt.type==%22overige%20overheidsinformatie%22)or(dt.type==%22participatie%22)or(dt.type==%22pensioenen%22)or(dt.type==%22tuchtrechtelijke%20uitspraak%22)or(dt.type==%22vervreemding%20erfgoed%22)or(dt.type==%22andere%20beschikking%22)or(dt.type==%22andere%20vergunning%22)or(dt.type==%22evenementenvergunning%22)or(dt.type==%22exploitatievergunning%22)or(dt.type==%22vergunning%20voor%20activiteiten%20op%20of%20in%20oppervlaktewater%22)or(dt.type==%22afvalinzameling%22)or(dt.type==%22andere%20voorlichtingsinformatie%22)or(dt.type==%22inspraak%22)or(dt.type==%22openingstijden%22)or(dt.type==%22vergadering%20of%20stuk%20van%20het%20bestuur%22)or(dt.type==%22verkiezingen%22))and(((w.publicatienaam==%22Tractatenblad%22))or((w.publicatienaam==%22Staatsblad%22))or((w.publicatienaam==%22Staatscourant%22))or((w.publicatienaam==%22Gemeenteblad%22))or((w.publicatienaam==%22Provinciaal%20blad%22))or((w.publicatienaam==%22Waterschapsblad%22))or((w.publicatienaam==%22Blad%20gemeenschappelijke%20regeling%22)))",
  },
  {
    id: "wetenregelgeving",
    naam: "wetenregelgeving",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://lokaleregelgeving.overheid.nl/ZoekResultaat?gemeenten=Zaanstad&count=50",
    paginering: {
      soort: "patroon",
      patroon: "https://lokaleregelgeving.overheid.nl/ZoekResultaat?gemeenten=Zaanstad&count=50&page={n}",
    },
  },
];
