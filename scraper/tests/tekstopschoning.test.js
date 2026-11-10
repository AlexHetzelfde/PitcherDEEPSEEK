const test = require("node:test");
const assert = require("node:assert/strict");
const { haalAlineaTekstUitHtml, haalPaginaTekstMetAlineas, schoonAlineas, deelInAlineas, isRommelRegel } = require("../tekstopschoning");

const LANG = "De gemeente Zaanstad heeft vandaag besloten om de brug over de Zaan tijdelijk te sluiten voor al het verkeer wegens onderhoud.";

const ARTIKEL = `<html><head><title>x</title></head><body>
<nav><a href="/">Home</a> <a href="/nieuws">Nieuws</a></nav>
<article>
  <h1>Brug dicht</h1>
  <p>${LANG}</p>
  <p>Fietsers
     worden omgeleid via de Dorpsstraat, meldt de gemeente in een persbericht dat woensdag is verstuurd.</p>
  <ul><li>Dicht van 3 tot en met 14 maart</li><li>Omleiding via de Dorpsstraat</li></ul>
  <p>Lees ook: Nieuwe fietsbrug gepland</p>
  <p>Delen</p>
  <p>Foto: Gemeente Zaanstad</p>
</article>
<footer>Contact · Disclaimer</footer>
</body></html>`;

test("alinea's blijven apart, een zin over twee bronregels blijft heel, rommel verdwijnt", () => {
  const uit = haalAlineaTekstUitHtml(ARTIKEL, { titel: "Brug dicht" });
  assert.equal(uit.methode, "artikel");
  const alineas = uit.tekst.split("\n\n");
  assert.equal(alineas[0], LANG); // de titel "Brug dicht" is niet herhaald
  assert.ok(alineas[1].startsWith("Fietsers worden omgeleid via de Dorpsstraat")); // één alinea
  assert.ok(alineas.includes("• Dicht van 3 tot en met 14 maart"));
  assert.ok(alineas.includes("• Omleiding via de Dorpsstraat"));
  assert.ok(!uit.tekst.includes("Lees ook"));
  assert.ok(!/^Delen$/m.test(uit.tekst));
  assert.ok(!uit.tekst.includes("Foto:"));
  assert.ok(!uit.tekst.includes("Disclaimer")); // footer weg
  assert.ok(!uit.tekst.includes("Nieuws")); // nav weg
});

test("geen bruikbare tekst en geen pdf geven null", () => {
  assert.equal(haalAlineaTekstUitHtml("<html><body><p>kort</p></body></html>"), null);
  assert.equal(haalAlineaTekstUitHtml("%PDF-1.4 ..."), null);
  assert.equal(haalAlineaTekstUitHtml(""), null);
});

test("de reservemethode voor een hele pagina houdt ook alinea's", () => {
  const html = `<html><body><main><p>${LANG}</p><p>${LANG} Er is een tweede alinea met genoeg woorden erin om mee te tellen.</p></main></body></html>`;
  const t = haalPaginaTekstMetAlineas(html, 100000);
  assert.equal(t.split("\n\n").length, 2);
});

test("schoonAlineas haalt alleen duidelijke rommel weg, geen echte zinnen", () => {
  const echt = "Sluiten van de brug is onvermijdelijk voor de veiligheid van weggebruikers.";
  const s = schoonAlineas(["Lees ook: iets anders", "Delen", echt, echt, "Foto: ANP", "Menu"].join("\n"));
  assert.equal(s.tekst, echt); // dubbele regel ook weg
  assert.equal(s.rommelRegels, 4);
});

test("schoonAlineas laat een titel aan het begin niet herhalen", () => {
  const s = schoonAlineas("Brug over de Zaan dicht\nDe brug gaat dicht voor onderhoud aan de pijlers.", { titel: "Brug over de Zaan dicht" });
  assert.equal(s.tekst, "De brug gaat dicht voor onderhoud aan de pijlers.");
  assert.equal(s.titelWeg, true);
});

test("een lange tekst zonder alinea's wordt op zinsgrenzen verdeeld, niet midden in een afkorting", () => {
  const zin = "Dhr. Jansen van de afdeling Openbare Ruimte legt uit dat het onderhoud noodzakelijk is voor de veiligheid.";
  const blok = Array.from({ length: 14 }, () => zin).join(" ");
  const s = schoonAlineas(blok);
  assert.equal(s.herleid, true);
  const alineas = s.tekst.split("\n\n");
  assert.ok(alineas.length >= 3);
  for (const a of alineas) {
    assert.ok(a.startsWith("Dhr. Jansen")); // nooit gesplitst achter "Dhr."
    assert.ok(a.endsWith("."));
  }
  assert.equal(alineas.join(" "), blok); // er is niets weggevallen
});

test("een korte tekst zonder alinea's blijft zoals hij is", () => {
  assert.equal(schoonAlineas("Eén korte zin.").tekst, "Eén korte zin.");
  assert.equal(deelInAlineas("Eén zin.").length, 1);
});

test("rommelherkenning: knoppen en credits wel, gewone zinnen niet", () => {
  assert.equal(isRommelRegel("Delen"), true);
  assert.equal(isRommelRegel("Lees ook: Nieuwe fietsbrug"), true);
  assert.equal(isRommelRegel("Foto: Peter de Vries"), true);
  assert.equal(isRommelRegel("Delen van de kosten gebeurt in overleg met de provincie."), false);
  assert.equal(isRommelRegel("Sluiten van de brug duurt twee weken."), false);
});

test("bronrommel aan het begin en eind van aan elkaar geplakte tekst verdwijnt", () => {
  const nh =
    "Publicatiedatum: 29 oktober 2026 Laatst gewijzigd: 30 oktober 2026 0 reacties De provincie publiceert vandaag het jaarverslag. " +
    "Delen op: Deel dit bericht op Facebook Deel dit bericht op X Deel dit bericht op LinkedIn Om te kunnen reageren moet u eerst inloggen.";
  assert.equal(schoonAlineas(nh).tekst, "De provincie publiceert vandaag het jaarverslag.");
  assert.equal(schoonAlineas("Vorige pagina Ambtsbezoek Commissaris van de Koning").tekst, "Ambtsbezoek Commissaris van de Koning");
  const wet = "Permalink Printen Permanente link Naar de actuele versie van de regeling https://lokaleregelgeving.overheid.nl/CVDR1 Naar de door u bekeken versie https://lokaleregelgeving.overheid.nl/CVDR1/3 Huisvestingsverordening 2025";
  assert.equal(schoonAlineas(wet).tekst, "Huisvestingsverordening 2025");
});

test("metaregels van de pagina zelf verdwijnen ook als ze op eigen regel staan", () => {
  const s = schoonAlineas("Publicatiedatum: 4 november 2026\nLaatst gewijzigd: 4 november 2026\n0 reacties\nDelen op:\nDe echte tekst begint hier en gaat verder.");
  assert.equal(s.tekst, "De echte tekst begint hier en gaat verder.");
});

test("iBabs-velden die met een streep aan elkaar hangen worden één regel per veld", () => {
  const s = schoonAlineas("NVDE — Ter kennisname — Onderwerp: Nieuwsbrief — Afzender: NVDE — Advies: Ter kennisname", { splitOp: " — " });
  assert.deepEqual(s.tekst.split("\n\n"), ["NVDE", "Ter kennisname", "Onderwerp: Nieuwsbrief", "Afzender: NVDE", "Advies: Ter kennisname"]);
  // zonder splitOp blijft een streep in gewone tekst gewoon staan
  assert.equal(schoonAlineas("Een zin — met een streep erin.").tekst, "Een zin — met een streep erin.");
});

test("een te lange regel tussen korte regels wordt ook verdeeld", () => {
  const zin = "De gemeente legt uit dat het onderhoud nodig is voor de veiligheid van alle weggebruikers.";
  const s = schoonAlineas(`Kopje\n${Array.from({ length: 14 }, () => zin).join(" ")}`);
  assert.equal(s.herleid, true);
  assert.ok(s.alineas >= 4);
});
