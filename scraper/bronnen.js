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
//    OmgevingsdienstNHN en zaandijk-leeft hebben rustig: true gekregen. Ze
//    publiceren niet dagelijks (hun nieuwste bericht is 5 tot 92 dagen oud),
//    waardoor ze zonder deze vlag na elke run in de herstel-lijst belandden.
//  - rechtspraak-noord-holland toegevoegd: de RSS-feed van de Rechtbank
//    Noord-Holland. Zonder filter komen alle uitspraken van de rechtbank
//    binnen (Haarlem, Alkmaar, Schiphol, Den Helder, Hoorn, enzovoort); de
//    AI-beoordeling vist de Zaanse zaken eruit. Een filterTermen-mechanisme
//    staat nog op de wensenlijst.

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
    naam: "zaandijk-leeft",
    categorie: "lokaal",
    type: "wordpress-html",
    url: "https://zaandijkleeft.nl/",
    rustig: true,
  },
  {
    id: "OmgevingsdienstNHN",
    naam: "OmgevingsdienstNHN",
    categorie: "lokaal",
    type: "generieke-lijst",
    url: "https://www.odnhn.nl/Menu/Over_ons/Nieuws/2022",
    rustig: true,
  },
  {
    id: "omgevingsdienstnoordzeekanaal",
    naam: "omgevingsdienstnoordzeekanaal",
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
  {
    id: "rechtspraak-noord-holland",
    naam: "Rechtspraak — Rechtbank Noord-Holland",
    categorie: "lokaal",
    type: "rss",
    url: "https://uitspraken.rechtspraak.nl/rss/?instantie=http%3A%2F%2Fstandaarden.overheid.nl%2Fowms%2Fterms%2FRechtbank_Noord-Holland&instantietype=2",
  },
];
