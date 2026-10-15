// voeg-bron-toe.js
//
// Voegt een nieuwe bron toe aan bronnen.js, en bewijst eerst dat die bron
// werkt. Wordt gestart door de workflow "Bron toevoegen" (en kan ook lokaal).
//
// Gebruik:
//   node voeg-bron-toe.js <url> <bron-id> <categorie> [soort]
//                         [--vervang] [--accepteer-twijfel]
//
//   categorie  lokaal | landelijk
//   soort      auto (standaard) | nieuws | agenda
//   --vervang  een bestaande bron met dit id mag worden vervangen, ook als
//              die nog werkt. Is de bestaande bron kapot (levert niets op),
//              dan wordt hij ook zonder deze vlag vervangen.
//   --accepteer-twijfel  ook een kandidaat toevoegen die de poort haalt maar
//              niet als link op de pagina voorkomt (zie bron-ontdekking.js)
//
// In Actions kunnen dezelfde opties als omgevingsvariabelen worden doorgegeven
// (SOORT, VERVANG, ACCEPTEER_TWIJFEL, NAAM), zodat er geen invoer in een shell-
// commando hoeft te staan.
//
// Sinds de "eerlijke-pipeline"-ronde (2026-10-15):
//  - Als een bestaande bron wordt vervangen, blijven detailSelector en rustig
//    behouden. Zonder die twee velden zou "opnieuw toevoegen" via deze route
//    (die het herstel-issue aanraadt) beide instellingen wissen.
//  - Er is een optionele naam-input. Zonder die input krijgt een nieuwe bron
//    "naam: id", wat in de feed lelijk staat (zoals de vijf bronnen die dat
//    al hadden).

const { ontdekBron, maakRapport, schrijfStapSamenvatting, isDirecteFeed } = require("./bron-ontdekking");
const { testBron, voorbeeldRegels, normaliseerUrl, telBinnenVenster } = require("./bron-poort");
const { schrijfBron } = require("./bronnen-schrijver");
const bronnen = require("./bronnen");

function leesArgumenten(argv) {
  const positioneel = argv.filter((a) => !a.startsWith("--"));
  const vlaggen = new Set(argv.filter((a) => a.startsWith("--")));
  const [url, id, categorie, soort] = positioneel;
  return {
    url,
    id,
    categorie,
    soort: (soort || process.env.SOORT || "auto").trim().toLowerCase(),
    naam: (process.env.NAAM || "").trim() || null,
    vervang: vlaggen.has("--vervang") || process.env.VERVANG === "true",
    accepteerTwijfel: vlaggen.has("--accepteer-twijfel") || process.env.ACCEPTEER_TWIJFEL === "true",
  };
}

function stopMetFout(bericht, samenvatting) {
  console.error(`\n✗ ${bericht}`);
  schrijfStapSamenvatting(`### ✗ Bron niet toegevoegd\n\n${samenvatting || bericht}`);
  process.exit(1);
}

async function main() {
  const { url, id, categorie, soort, naam, vervang, accepteerTwijfel } = leesArgumenten(process.argv.slice(2));

  if (!url || !id || !categorie) {
    stopMetFout("Gebruik: node voeg-bron-toe.js <url> <bron-id> <categorie> [soort] [--vervang] [--accepteer-twijfel]");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) stopMetFout(`Bron-id "${id}" mag alleen letters, cijfers en streepjes bevatten (geen spaties).`);
  if (!["lokaal", "landelijk"].includes(categorie)) stopMetFout(`Categorie "${categorie}" bestaat niet: kies lokaal of landelijk.`);
  if (!["auto", "nieuws", "agenda"].includes(soort)) stopMetFout(`Soort "${soort}" bestaat niet: kies auto, nieuws of agenda.`);
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    stopMetFout(`"${url}" is geen geldige http(s)-url.`);
  }

  // Staat deze url (genormaliseerd: zonder www, #anker, slash aan het eind en tracking-parameters)
  // al bij een andere bron? Dan zou je dezelfde berichten dubbel ophalen. Dezelfde url bij
  // hetzelfde id is het vervangen van die ene bron en mag (zie hieronder).
  const genormaliseerdeUrl = normaliseerUrl(url);
  const dubbeleBron = bronnen.find((b) => b.id !== id && normaliseerUrl(b.url) === genormaliseerdeUrl);
  if (dubbeleBron) {
    stopMetFout(
      `Deze url staat al in bronnen.js bij de bron "${dubbeleBron.id}" (${dubbeleBron.url}). Een tweede bron met dezelfde pagina haalt dezelfde berichten dubbel op. Gebruik het bestaande id "${dubbeleBron.id}" met "vervang" aan als je die bron opnieuw wilt laten uitzoeken.`
    );
  }

  // Bestaat het id al? Een werkende bron overschrijven we alleen met --vervang.
  const bestaand = bronnen.find((b) => b.id === id);
  if (bestaand) {
    console.log(`Er bestaat al een bron met id "${id}" (${bestaand.type}, ${bestaand.url}). Controleren of die nog werkt...`);
    const oordeel = await testBron(bestaand, { siteUrl: bestaand.url });
    if (oordeel.geslaagd && !vervang) {
      stopMetFout(
        `De bestaande bron "${id}" werkt nog (${oordeel.aantal} bericht(en)). Kies een ander id, of zet "vervang" aan als je 'm bewust wilt vervangen.`
      );
    }
    console.log(
      oordeel.geslaagd
        ? "De bestaande bron werkt, maar wordt op verzoek vervangen."
        : `De bestaande bron is kapot (${oordeel.redenen[0] || "geen bruikbare berichten"}). Die wordt vervangen.`
    );
  }

  // Gemini is alleen verplicht voor HTML-pagina's. Als de URL zelf een
  // feed is, werkt ontdekBron zonder Gemini.
  const isFeed = await isDirecteFeed(url);
  if (isFeed) {
    console.log(`De opgegeven URL is een RSS/Atom-feed. Geen GEMINI_API_KEY nodig.`);
  } else if (!process.env.GEMINI_API_KEY) {
    stopMetFout(
      "GEMINI_API_KEY ontbreekt. Voor een gewone HTML-pagina heeft het toevoegen van een bron Gemini nodig: Gemini leest de hele pagina en geeft de lijst van berichten waartegen elke methode wordt gecontroleerd. Voor een RSS/Atom-feed is Gemini niet nodig — voer de feed-URL rechtstreeks in, of zet het secret GEMINI_API_KEY in de repo-instellingen (Settings > Secrets and variables > Actions)."
    );
  }

  // Naam: input > bestaande naam > id.
  const effectieveNaam = naam || (bestaand ? bestaand.naam : id);

  const uit = await ontdekBron({
    url,
    id,
    naam: effectieveNaam,
    categorie,
    soort,
    apiKey: process.env.GEMINI_API_KEY,
    // Behoud detailSelector van de bestaande bron, zodat "opnieuw toevoegen"
    // via deze route (die het herstel-issue aanraadt) dat veld niet wist.
    detailSelector: bestaand ? bestaand.detailSelector : undefined,
  });

  if (!uit.bron) {
    const rapport = maakRapport({ url, id, verslag: uit.verslag, fout: uit.fout });
    console.error(`\n${rapport}`);
    stopMetFout(`Geen enkele methode kon "${id}" bewijsbaar ophalen. Er is niets aan bronnen.js veranderd.`, rapport);
  }

  if (uit.twijfelachtig && !accepteerTwijfel) {
    const rapport = maakRapport({ url, id, verslag: uit.verslag });
    stopMetFout(
      `Er is alleen een twijfelachtige kandidaat (${uit.bron.type}, ${uit.bron.url}): hij slaagt de poort, maar geen enkel bericht staat als link op de pagina. Controleer de voorbeeldberichten hierboven en start opnieuw met "accepteer twijfel" aan als ze kloppen.`,
      rapport
    );
  }

  // Behoud rustig-vlag van de bestaande bron. ontdekBron zet rustig alleen
  // als de poort te weinig berichten vindt; zonder deze regel zou een
  // bewust-rustige bron bij het vervangen zijn vlag kwijtraken.
  if (bestaand && bestaand.rustig && !uit.bron.rustig) uit.bron.rustig = true;

  const { actie } = await schrijfBron(uit.bron);

  const venster = telBinnenVenster(uit.oordeel, uit.bron);
  const geenBinnenVenster =
    venster.binnen === 0
      ? `Geen enkel van de ${venster.totaal} bewezen berichten valt binnen ${venster.vensterTekst}: vandaag zou deze bron dus niets opleveren.${uit.bron.rustig ? " De bron is als rustig gemarkeerd, dus de dagelijkse run waarschuwt hier verder niet voor." : ""} Dat kan kloppen (een rustige bron, of een agenda die nu leeg is), maar controleer in de voorbeelden of de datums en het jaar goed gelezen zijn.`
      : null;

  const voorbeelden = voorbeeldRegels(uit.oordeel, 5).join("\n");
  console.log(`\n✓ Bron "${id}" ${actie} in bronnen.js: type ${uit.bron.type}${uit.bron.soort ? `, soort ${uit.bron.soort}` : ""}${uit.bron.rustig ? ", rustige bron" : ""}.`);
  console.log(`  Bewezen met de echte scraper: ${uit.oordeel.aantal} bericht(en).`);
  console.log(`  Tekstdekking: ${uit.oordeel.tekstTekst || "niet gemeten (feed-modus: items hebben al tekst)"}.`);
  console.log(`  Binnen het venster: ${venster.binnen} van ${venster.totaal} bericht(en).`);
  if (geenBinnenVenster) {
    console.log(`  ⚠️  ${geenBinnenVenster}`);
    console.log(`::warning title=Bron ${id}: 0 berichten binnen het venster::${geenBinnenVenster}`);
  }
  if (uit.oordeel.soortReden) console.log(`  ${uit.oordeel.soortReden}`);
  console.log(`  Voorbeelden:\n${voorbeelden}`);
  uit.oordeel.waarschuwingen.forEach((w) => console.log(`  ⚠️  ${w}`));
  console.log("Commit en push bronnen.js om 'm mee te nemen in de volgende dagelijkse run.");

  schrijfStapSamenvatting(
    [
      `### ✓ Bron \`${id}\` ${actie}`,
      "",
      `- Methode: \`${uit.bron.type}\`${uit.bron.soort ? `, soort \`${uit.bron.soort}\`` : ""}${uit.bron.rustig ? ", rustige bron" : ""}`,
      `- Bewezen met de echte scraper: ${uit.oordeel.aantal} bericht(en)`,
      `- Tekstdekking: ${uit.oordeel.tekstTekst || "niet gemeten (feed-modus: items hebben al tekst)"}`,
      `- Binnen het venster: ${venster.binnen} van ${venster.totaal} bericht(en)`,
      ...(uit.oordeel.soortReden ? [`- ${uit.oordeel.soortReden}`] : []),
      ...(geenBinnenVenster ? ["", `> ⚠️ **Let op: 0 berichten binnen het venster.** ${geenBinnenVenster}`] : []),
      "",
      "Voorbeelden:",
      "",
      "```",
      voorbeelden,
      "```",
      ...uit.oordeel.waarschuwingen.map((w) => `- ⚠️ ${w}`),
    ].join("\n")
  );
}

main().catch((fout) => {
  console.error(`\n✗ Onverwachte fout: ${fout.stack || fout.message}`);
  schrijfStapSamenvatting(`### ✗ Onverwachte fout\n\n\`\`\`\n${fout.message}\n\`\`\``);
  process.exit(1);
});
