// zanp-bronnen.js
//
// Bronnen die ALLEEN door ZANP (de nieuwsstroom, zanp.js) worden gescrapet.
// De nachtelijke pitchrun (index.js) leest alleen bronnen.js en slaat deze
// lijst dus over. Voeg hier een bron toe als hij wel in de nieuwsstroom moet,
// maar niet in de pitches. Vergeet niet een regel in rubrieken.json.
//
// Dit bestand wordt niet door "Bron toevoegen" of "Bron herstellen"
// herschreven: die workflows werken alleen op bronnen.js.

module.exports = [
  {
    id: "vervoerregio-overzichten",
    naam: "Vervoerregio: Overzichten (iBabs)",
    categorie: "lokaal",
    type: "ibabs-dashboard",
    url: "https://vervoerregio.bestuurlijkeinformatie.nl/",
    // Er verschijnen maar een paar items per week. Zonder deze regel gaat ZANP
    // na drie lege runs steeds minder vaak kijken (tot eens per 6 uur).
    nooitVertragen: true,
  },
  {
    // Moties van de gemeenteraad, alleen na een stemming (aangenomen of
    // verworpen), met stemming en strekking. Zie scrapers/moties.js.
    id: "zaanstad-moties",
    naam: "Gemeente Zaanstad: moties en stemmingen (iBabs)",
    categorie: "lokaal",
    type: "moties",
    url: "https://zaanstad.bestuurlijkeinformatie.nl/Reports/Details/4b5dcb7b-adc3-4253-bad3-7bfd16341021",
    // Een raadsvergadering levert een paar keer per jaar veel moties tegelijk;
    // zonder deze regel gaat ZANP in de rustige weken steeds minder vaak kijken.
    nooitVertragen: true,
  },
  {
    // Cameratoezicht in Zaanstad uit officielebekendmakingen.nl, met reeksen per
    // plek (eerste aanwijzing, verlengingen). Zie scrapers/camera.js en camera-reeks.js.
    id: "zaanstad-camera",
    naam: "Gemeente Zaanstad: cameratoezicht (officielebekendmakingen.nl)",
    categorie: "lokaal",
    type: "camera",
    url:
      "https://zoek.officielebekendmakingen.nl/rss" +
      "?q=(c.product-area==%22officielepublicaties%22)" +
      "and(((w.publicatienaam==%22Tractatenblad%22))" +
      "or((w.publicatienaam==%22Staatsblad%22))" +
      "or((w.publicatienaam==%22Staatscourant%22))" +
      "or((w.publicatienaam==%22Gemeenteblad%22))" +
      "or((w.publicatienaam==%22Provinciaal%20blad%22))" +
      "or((w.publicatienaam==%22Waterschapsblad%22))" +
      "or((w.publicatienaam==%22Blad%20gemeenschappelijke%20regeling%22)))" +
      "and(cql.textAndIndexes=%22camera%22)" +
      "%20AND%20dt.creator==%22Zaanstad%22",
    nooitVertragen: true,
  },
  {
    // Aanbestedingen boven de Europese drempel (TED). Zie scrapers/ted.js.
    id: "zaanstad-ted",
    naam: "Gemeente Zaanstad: aanbestedingen (TED)",
    categorie: "lokaal",
    type: "ted",
    url: "https://api.ted.europa.eu/v3/notices/search",
    zoeknaam: "Zaanstad",
    nooitVertragen: true,
  },
  {
    // Aanbestedingen uit TenderNed, ook nationaal en onder de drempel. Zie scrapers/tenderned.js.
    id: "zaanstad-tenderned",
    naam: "Gemeente Zaanstad: aanbestedingen (TenderNed)",
    categorie: "lokaal",
    type: "tenderned",
    url: "https://www.tenderned.nl/papi/tenderned-rs-tns/v2",
    zoeknaam: "Zaanstad",
    nooitVertragen: true,
  },
];
