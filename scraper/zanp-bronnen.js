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
];
