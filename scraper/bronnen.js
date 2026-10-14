// bronnen.js
//
// Centrale lijst van bronnen. Elke bron krijgt een categorie: "lokaal" of "landelijk".
// Voeg hier nieuwe bronnen toe zodra je er meer wilt scrapen — de rest van de
// pipeline (AI-beoordeling, front-end) werkt automatisch mee.
//
// Sinds de "schone tekst"-ronde (2026-10-13) mogen bronnen een optioneel
// veld "detailSelector" hebben: een CSS-selector die op de detailpagina als
// eerste wordt geprobeerd. Bedoeld voor sites waarvan de artikeltekst in een
// specifiek blok zit dat de generieke selectors zouden missen.
//
// Sinds de "evenementdatum"-ronde (2026-10-14):
//  - zaansche-molen, ovo-zaanstad en blaise-pascal-college hebben rustig: true
//    gekregen (ze publiceren niet dagelijks; de herstel-drempel gaat van 2 naar
//    14 runs zonder berichten binnen het venster).
//  - zaanstad-hoorzittingen heeft soort: "agenda" gekregen (de auto-detectie
//    herkende het al correct, maar de expliciete config haalt de waarschuwing
//    uit elke run).
//  - zaans-cultuur-huis is veranderd van generieke-lijst naar gemini-recept
//    met expliciete selectors, en heeft soort: "agenda" gekregen. De oude
//    RSS-feed gaf alleen de publicatiedatum (bijv. 12 oktober voor een
//    evenement op 27 november), waardoor evenementen alleen in de feed
//    verschenen op de dag van aankondiging en niet op de dag van het
//    evenement zelf. Nu wordt time.event-date (het datetime-attribuut)
//    gebruikt, wat exact de evenementdatum is.
//  - hhnk-actueel en pascal-zuid zijn verwijderd: hhnk-actueel is een
//    doorverwijspagina zonder berichten, pascal-zuid leverde 1 bericht
//    zonder leesbare datum op.

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
  },
  {
    id: "ibabs-ingekomen-stukken",
    naam: "Zaanstad — Ingekomen stukken (iBabs)",
    categorie: "lokaal",
    type: "ibabs",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/58e397b1-0b36-49e2-90ed-325405f27f72",
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
  },
  {
    id: "zaanse-schans",
    naam: "Zaanse Schans — Actueel",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.dezaanseschans.nl/contact/actueel/",
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
    naam: "zaandijk-leeft",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://zaandijkleeft.nl/",
  },
  {
    id: "OmgevingsdienstNHN",
    naam: "OmgevingsdienstNHN",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.odnhn.nl/Menu/Over_ons/Nieuws/2022",
  },
  {
    id: "omgevingsdienstnoordzeekanaal",
    naam: "omgevingsdienstnoordzeekanaal",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://odnzkg.nl/nieuws/",
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
    naam: "WaarheenAgenda",
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
    naam: "hhnk",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.hhnk.nl/nieuws",
  },
];
