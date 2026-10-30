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
//   --vervang  een bestaande bron met dit id mag worden vervangen
//   --accepteer-twijfel  ook een twijfelachtige kandidaat toevoegen
//
// In Actions kunnen dezelfde opties als omgevingsvariabelen worden doorgegeven
// (SOORT, VERVANG, ACCEPTEER_TWIJFEL, NAAM, RUBRIEK, HERKOMST, AGENDA_FILTER).
//
// Sinds de ZANP-fase-2-ronde (2026-10-26):
//  - Een nieuwe bron moet verplicht een RUBRIEK hebben. Zonder geldige
//    RUBRIEK stopt het script met een duidelijke foutmelding.
//  - Een bestaande bron behoudt zijn rubriek als RUBRIEK "behouden" is.

const { ontdekBron, maakRapport, schrijfStapSamenvatting, isDirecteFeed } = require("./bron-ontdekking");
const { testBron, voorbeeldRegels, normaliseerUrl, telBinnenVenster } = require("./bron-poort");
const { schrijfBron } = require("./bronnen-schrijver");
const bronnen = require("./bronnen");
const { RUBRIEKEN, profielVoor, isBekendeBron, voegProfielToe } = require("./rubrieken");
const { beoordeelAgendaRelevantie } = require("./agenda-regels");

const GELDIGE_HERKOMSTEN = ["signaal", "officieel", "organisatie"];
const GELDIGE_AGENDAFILTERS = ["alles", "eerste-of-jubileum"];

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
    rubriek: (process.env.RUBRIEK || "behouden").trim(),
    herkomst: (process.env.HERKOMST || "behouden").trim().toLowerCase(),
    agendaFilter: (process.env.AGENDA_FILTER || "behouden").trim().toLowerCase(),
  };
}

function bepaalZanpProfiel({ id, invoer, soort }) {
  const huidig = isBekendeBron(id) ? profielVoor(id) : null;
  const kies = (waarde, bestaandeWaarde, standaard) =>
    waarde && waarde !== "behouden"
      ? waarde
      : bestaandeWaarde !== undefined && bestaandeWaarde !== null
        ? bestaandeWaarde
        : standaard;

  const rubriek = kies(invoer.rubriek, huidig && huidig.rubriek, "ALG");
  const herkomst = kies(invoer.herkomst, huidig && huidig.herkomst, "onbekend");
  const agendaFilter =
    soort === "agenda" ? kies(invoer.agendaFilter, huidig && huidig.agendaFilter, "alles") : undefined;
  const mag = herkomst === "officieel" || herkomst === "organisatie";
  const herschrijf = huidig && huidig.herkomst === herkomst ? huidig.herschrijf === true && mag : mag;
  const prio =
    huidig && huidig.herkomst === herkomst && Number.isInteger(huidig.prio)
      ? huidig.prio
      : herkomst === "organisatie"
        ? 4
        : 3;
  return { rubriek, herkomst, herschrijf, prio, ...(agendaFilter ? { agendaFilter } : {}) };
}

function stopMetFout(bericht, samenvatting) {
  console.error(`\n✗ ${bericht}`);
  schrijfStapSamenvatting(`### ✗ Bron niet toegevoegd\n\n${samenvatting || bericht}`);
  process.exit(1);
}

async function main() {
  const argumenten = leesArgumenten(process.argv.slice(2));
  const { url, id, categorie, soort, naam, vervang, accepteerTwijfel } = argumenten;

  if (!url || !id || !categorie) {
    stopMetFout(
      "Gebruik: node voeg-bron-toe.js <url> <bron-id> <categorie> [soort] [--vervang] [--accepteer-twijfel]"
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    stopMetFout(`Bron-id "${id}" mag alleen letters, cijfers en streepjes bevatten.`);
  }
  if (!["lokaal", "landelijk"].includes(categorie)) {
    stopMetFout(`Categorie "${categorie}" bestaat niet: kies lokaal of landelijk.`);
  }
  if (!["auto", "nieuws", "agenda"].includes(soort)) {
    stopMetFout(`Soort "${soort}" bestaat niet: kies auto, nieuws of agenda.`);
  }

  const geldigeRubrieken = RUBRIEKEN.map((r) => r.code);
  if (argumenten.rubriek !== "behouden" && !geldigeRubrieken.includes(argumenten.rubriek)) {
    stopMetFout(
      `Rubriek "${argumenten.rubriek}" bestaat niet. Kies uit: ${geldigeRubrieken.join(", ")}, of "behouden".`
    );
  }
  if (argumenten.herkomst !== "behouden" && !GELDIGE_HERKOMSTEN.includes(argumenten.herkomst)) {
    stopMetFout(
      `Herkomst "${argumenten.herkomst}" bestaat niet: kies ${GELDIGE_HERKOMSTEN.join(", ")} of "behouden".`
    );
  }
  if (argumenten.agendaFilter !== "behouden" && !GELDIGE_AGENDAFILTERS.includes(argumenten.agendaFilter)) {
    stopMetFout(
      `Agendafilter "${argumenten.agendaFilter}" bestaat niet: kies ${GELDIGE_AGENDAFILTERS.join(" of ")} of "behouden".`
    );
  }
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    stopMetFout(`"${url}" is geen geldige http(s)-url.`);
  }

  const bestaand = bronnen.find((b) => b.id === id);
  if (!bestaand && (!process.env.RUBRIEK || process.env.RUBRIEK === "behouden")) {
    stopMetFout(
      "Bij het toevoegen van een nieuwe bron is een rubriek verplicht. Geef de TAG op (kies uit: " + RUBRIEKEN.map((r) => r.code).join(", ") + ")."
    );
  }

  const genormaliseerdeUrl = normaliseerUrl(url);
  const dubbeleBron = bronnen.find((b) => b.id !== id && normaliseerUrl(b.url) === genormaliseerdeUrl);
  if (dubbeleBron) {
    stopMetFout(
      `Deze url staat al in bronnen.js bij de bron "${dubbeleBron.id}". Gebruik het bestaande id "${dubbeleBron.id}" met "vervang" aan.`
    );
  }

  if (bestaand) {
    console.log(`Er bestaat al een bron met id "${id}" (${bestaand.type}, ${bestaand.url}). Controleren...`);
    const oordeel = await testBron(bestaand, { siteUrl: bestaand.url });
    if (oordeel.geslaagd && !vervang) {
      stopMetFout(
        `De bestaande bron "${id}" werkt nog (${oordeel.aantal} bericht(en)). Kies een ander id, of zet "vervang" aan.`
      );
    }
    console.log(
      oordeel.geslaagd
        ? "De bestaande bron werkt, maar wordt op verzoek vervangen."
        : `De bestaande bron is kapot (${oordeel.redenen[0] || "geen bruikbare berichten"}). Die wordt vervangen.`
    );
  }

  const isFeed = await isDirecteFeed(url);
  if (isFeed) {
    console.log("De opgegeven URL is een RSS/Atom-feed. Geen GEMINI_API_KEY nodig.");
  } else if (!process.env.GEMINI_API_KEY) {
    stopMetFout(
      "GEMINI_API_KEY ontbreekt. Voor een gewone HTML-pagina heeft het toevoegen van een bron Gemini nodig. Voor een RSS/Atom-feed is Gemini niet nodig."
    );
  }

  const effectieveNaam = naam || (bestaand ? bestaand.naam : id);

  const uit = await ontdekBron({
    url,
    id,
    naam: effectieveNaam,
    categorie,
    soort,
    apiKey: process.env.GEMINI_API_KEY,
    detailSelector: bestaand ? bestaand.detailSelector : undefined,
  });

  if (!uit.bron) {
    const rapport = maakRapport({ url, id, verslag: uit.verslag, fout: uit.fout });
    console.error(`\n${rapport}`);
    stopMetFout(
      `Geen enkele methode kon "${id}" bewijsbaar ophalen. Er is niets aan bronnen.js veranderd.`,
      rapport
    );
  }

  if (uit.twijfelachtig && !accepteerTwijfel) {
    const rapport = maakRapport({ url, id, verslag: uit.verslag });
    stopMetFout(
      `Er is alleen een twijfelachtige kandidaat (${uit.bron.type}, ${uit.bron.url}). Controleer de voorbeeldberichten en start opnieuw met "accepteer twijfel" aan als ze kloppen.`,
      rapport
    );
  }

  if (bestaand && bestaand.rustig && !uit.bron.rustig) uit.bron.rustig = true;
  if (bestaand && bestaand.filterTermen && !uit.bron.filterTermen) {
    uit.bron.filterTermen = bestaand.filterTermen;
  }

  const { actie } = await schrijfBron(uit.bron);

  const zanp = bepaalZanpProfiel({ id, invoer: argumenten, soort: uit.bron.soort });
  voegProfielToe(id, zanp);
  const zanpRegel = `ZANP: rubriek ${zanp.rubriek}, herkomst ${zanp.herkomst}, ${
    zanp.herschrijf ? "AI-samenvatting toegestaan" : "alleen kop en link"
  }, prio ${zanp.prio}${zanp.agendaFilter ? `, agendafilter ${zanp.agendaFilter}` : ""}.`;
  const zanpWaarschuwingen = [];
  if (categorie === "landelijk") {
    zanpWaarschuwingen.push(
      "Een landelijke bron doet niet mee aan ZANP (die is regionaal); hij blijft wel in het pitchdeel."
    );
  }
  if (zanp.herkomst === "onbekend") {
    zanpWaarschuwingen.push(
      "Herkomst is nog onbekend: de berichten komen onder Overig, zonder AI-tekst."
    );
  }
  let agendaRegel = null;
  if (uit.bron.soort === "agenda") {
    const items = uit.oordeel.geldig || [];
    const door = items.filter(
      (b) => beoordeelAgendaRelevantie(b.titel, b.samenvatting || "", zanp.agendaFilter).zichtbaar
    ).length;
    agendaRegel = `Agendafilter "${zanp.agendaFilter}": ${door} van ${items.length} geteste item(s) zouden in de agenda zichtbaar zijn.`;
    if (zanp.agendaFilter === "eerste-of-jubileum" && items.length >= 10 && door / items.length < 0.05) {
      zanpWaarschuwingen.push(
        `Bijna niets komt door het agendafilter (${door} van ${items.length}). Kies agenda_filter "alles" als je deze agenda volledig wilt zien.`
      );
    }
  }

  const venster = telBinnenVenster(uit.oordeel, uit.bron);
  const geenBinnenVenster =
    venster.binnen === 0
      ? `Geen enkel van de ${venster.totaal} bewezen berichten valt binnen ${venster.vensterTekst}: vandaag zou deze bron dus niets opleveren.${
          uit.bron.rustig
            ? " De bron is als rustig gemarkeerd, dus de dagelijkse run waarschuwt hier verder niet voor."
            : ""
        } Dat kan kloppen, maar controleer in de voorbeelden of de datums en het jaar goed gelezen zijn.`
      : null;

  const voorbeelden = voorbeeldRegels(uit.oordeel, 5).join("\n");
  console.log(
    `\n✓ Bron "${id}" ${actie} in bronnen.js: type ${uit.bron.type}${
      uit.bron.soort ? `, soort ${uit.bron.soort}` : ""
    }${uit.bron.rustig ? ", rustige bron" : ""}.`
  );
  console.log(`  Bewezen met de echte scraper: ${uit.oordeel.aantal} bericht(en).`);
  console.log(
    `  Tekstdekking: ${uit.oordeel.tekstTekst || "niet gemeten (feed-modus: items hebben al tekst)"}.`
  );
  console.log(`  Binnen het venster: ${venster.binnen} van ${venster.totaal} bericht(en).`);
  if (geenBinnenVenster) {
    console.log(`  ⚠️  ${geenBinnenVenster}`);
    console.log(`::warning title=Bron ${id}: 0 berichten binnen het venster::${geenBinnenVenster}`);
  }
  if (uit.oordeel.soortReden) console.log(`  ${uit.oordeel.soortReden}`);
  console.log(`  Voorbeelden:\n${voorbeelden}`);
  uit.oordeel.waarschuwingen.forEach((w) => console.log(`  ⚠️  ${w}`));
  console.log(`  ${zanpRegel}`);
  if (agendaRegel) console.log(`  ${agendaRegel}`);
  zanpWaarschuwingen.forEach((w) => {
    console.log(`  ⚠️  ${w}`);
    console.log(`::warning title=Bron ${id} (ZANP)::${w}`);
  });
  console.log("Commit en push bronnen.js en rubrieken.json om 'm mee te nemen in de volgende runs.");

  schrijfStapSamenvatting(
    [
      `### ✓ Bron \`${id}\` ${actie}`,
      "",
      `- Methode: \`${uit.bron.type}\`${uit.bron.soort ? `, soort \`${uit.bron.soort}\`` : ""}${
        uit.bron.rustig ? ", rustige bron" : ""
      }`,
      `- Bewezen met de echte scraper: ${uit.oordeel.aantal} bericht(en)`,
      `- Tekstdekking: ${uit.oordeel.tekstTekst || "niet gemeten (feed-modus: items hebben al tekst)"}`,
      `- Binnen het venster: ${venster.binnen} van ${venster.totaal} bericht(en)`,
      ...(uit.oordeel.soortReden ? [`- ${uit.oordeel.soortReden}`] : []),
      `- ${zanpRegel}`,
      ...(agendaRegel ? [`- ${agendaRegel}`] : []),
      ...(geenBinnenVenster ? ["", `> ⚠️ **Let op: 0 berichten binnen het venster.** ${geenBinnenVenster}`] : []),
      ...zanpWaarschuwingen.map((w) => `\n> ⚠️ ${w}`),
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
