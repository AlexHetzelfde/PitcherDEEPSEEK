// nieuwscriteria.js
//
// De ENIGE bron van waarheid voor de nieuwscriteria. Alle prompts (filter,
// pitch) lezen uit dit bestand, zodat er geen verschillende namen of
// definities meer zijn.
//
// Bron: Basisboek journalistiek schrijven, §5.1.3, p. 151-153 (en p. 154
// voor hoor en wederhoor, p. 33 voor perspectief).
//
// TWEE SOORTEN CRITERIA:
//   - KERN: belang, omvang, afwijking, inzicht, gevolgen.
//   - VERSTERKER: wie (bekend persoon), nieuws van morgen, voor het eerst,
//     primeur, amusement.
//
// DE REGEL: een versterker telt alleen mee als minstens één kerncriterium
// boven 0 scoort. Zonder kern is de totaalscore 0, ongeacht de versterkers.
// Zo valt een jubileum van een entertainer af (geen kern) en zakt een
// routinebesluit (lage kern) weg.
//
// De weging en drempel zijn instelbare getallen, zodat je ze kunt bijstellen
// zonder een prompt te herschrijven.

const KERN_CRITERIA = ["belang", "omvang", "afwijking", "inzicht", "gevolgen"];
const VERSTERKER_CRITERIA = ["wie", "nieuwsVanMorgen", "voorHetEerst", "primeur", "amusement"];

const CRITERIA = [
  // --- KERN ---
  {
    id: "belang",
    naam: "Belang",
    type: "kern",
    boekpagina: "p. 153",
    beschrijving: "Raakt mensen in de regio, ook wie er niet direct bij betrokken is.",
    ankers: {
      0: "Raakt alleen direct betrokkenen, geen bredere groep.",
      1: "Raakt een kleine groep in de regio (tientallen mensen).",
      2: "Raakt een grotere groep in de regio (honderden mensen) of een hele sector.",
      3: "Raakt vrijwel iedereen in de regio of een groot deel van de inwoners.",
    },
  },
  {
    id: "omvang",
    naam: "Omvang",
    type: "kern",
    boekpagina: "p. 153",
    beschrijving: "Veel mensen, veel geld, veel impact.",
    ankers: {
      0: "Klein: minder dan € 10.000 of minder dan 50 mensen.",
      1: "Bescheiden: € 10.000 tot € 100.000 of 50 tot 500 mensen.",
      2: "Groot: € 100.000 tot € 1 miljoen of 500 tot 5.000 mensen.",
      3: "Zeer groot: meer dan € 1 miljoen of meer dan 5.000 mensen.",
    },
  },
  {
    id: "afwijking",
    naam: "Afwijking",
    type: "kern",
    boekpagina: "p. 152",
    beschrijving: "Wijkt af van het alledaagse, is bijzonder of opvallend.",
    ankers: {
      0: "Routine, alledaags, verwacht.",
      1: "Licht afwijkend, maar niet verrassend.",
      2: "Duidelijk afwijkend, opvallend.",
      3: "Zeer afwijkend, uitzonderlijk, nooit eerder vertoond.",
    },
  },
  {
    id: "inzicht",
    naam: "Inzicht",
    type: "kern",
    boekpagina: "p. 153",
    beschrijving: "Maakt een maatschappelijk probleem begrijpelijker.",
    ankers: {
      0: "Geen maatschappelijk probleem zichtbaar.",
      1: "Raakt een probleem, maar legt het niet uit.",
      2: "Maakt een probleem begrijpelijk voor een deel.",
      3: "Maakt een complex probleem volledig begrijpelijk.",
    },
  },
  {
    id: "gevolgen",
    naam: "Gevolgen voor het dagelijks leven",
    type: "kern",
    boekpagina: "p. 154",
    beschrijving: "Heeft consequenties voor het dagelijks leven van mensen.",
    ankers: {
      0: "Geen concrete consequentie voor het dagelijks leven.",
      1: "Kleine consequentie voor een kleine groep.",
      2: "Duidelijke consequentie voor een grotere groep.",
      3: "Ingrijpende consequentie voor veel mensen.",
    },
  },
  {
    id: "lokaleRelevantie",
    naam: "Lokale relevantie",
    type: "kern",
    boekpagina: "p. 154 (regionaliseren)",
    alleenLandelijk: true,
    beschrijving: "Heeft het landelijke bericht een aanknopingspunt in Zaanstreek-Waterland?",
    ankers: {
      0: "Geen enkel aanknopingspunt in de regio.",
      1: "Een zwak aanknopingspunt (bijvoorbeeld een sector die ook lokaal bestaat).",
      2: "Een duidelijk aanknopingspunt (bijvoorbeeld een lokale instelling of groep).",
      3: "Een direct aanknopingspunt (bijvoorbeeld een Zaanse instelling of inwoner).",
    },
  },

  // --- VERSTERKERS ---
  {
    id: "wie",
    naam: "Wie (bekend persoon)",
    type: "versterker",
    boekpagina: "p. 153",
    beschrijving: "Gaat over een bekend persoon in de regio.",
    ankers: {
      0: "Geen bekende persoon.",
      1: "Een regionaal bekende persoon, zijdelings genoemd.",
      2: "Een regionaal bekende persoon, centraal in het bericht.",
      3: "Een landelijk bekende persoon met een regionale link.",
    },
  },
  {
    id: "nieuwsVanMorgen",
    naam: "Nieuws van morgen",
    type: "versterker",
    boekpagina: "p. 153",
    beschrijving: "Kondigt iets aan dat nog gaat komen, en dat belangrijk, groot of bijzonder is. Een aankondiging van een klein evenement is geen nieuws van morgen.",
    ankers: {
      0: "Geen aankondiging.",
      1: "Een aankondiging van iets kleins.",
      2: "Een aankondiging van iets belangrijks.",
      3: "Een aankondiging van iets groots dat veel mensen raakt.",
    },
  },
  {
    id: "voorHetEerst",
    naam: "Voor het eerst",
    type: "versterker",
    boekpagina: "p. 152",
    beschrijving: "Een debuut, eerste editie of opening. Een jubileum is GEEN 'voor het eerst': dat is een herhaling. Alleen een echte eerste keer telt.",
    ankers: {
      0: "Geen eerste keer.",
      1: "Een 'eerste' die geen gebeurtenis is (bijvoorbeeld alleen het woord in de titel).",
      2: "Een echte eerste keer (debuut, eerste editie).",
      3: "Een historische eerste keer (nooit eerder vertoond in de regio).",
    },
  },
  {
    id: "primeur",
    naam: "Primeur",
    type: "versterker",
    boekpagina: "p. 153",
    beschrijving: "Exclusief, als eerste naar buiten gebracht.",
    ankers: {
      0: "Geen primeur.",
      1: "Een kleine primeur (als eerste gemeld, maar niet uniek).",
      2: "Een duidelijke primeur.",
      3: "Een exclusief verhaal.",
    },
  },
  {
    id: "amusement",
    naam: "Amusement",
    type: "versterker",
    boekpagina: "p. 152",
    beschrijving: "Grappig of opvallend luchtig.",
    ankers: {
      0: "Niet grappig of luchtig.",
      1: "Licht luchtig.",
      2: "Duidelijk grappig of luchtig.",
      3: "Hilarisch of zeer opvallend luchtig.",
    },
  },
];

// Weging per criterium. De som van kern × 3 = 24, versterker × 3 = 10.5.
// Lokaal maximum = 34.5, landelijk maximum = 40.5 (lokaleRelevantie erbij).
const WEGING = {
  kern: {
    belang: 2.0,
    omvang: 1.5,
    afwijking: 1.5,
    inzicht: 1.0,
    gevolgen: 2.0,
    lokaleRelevantie: 2.0,
  },
  versterker: {
    wie: 0.5,
    nieuwsVanMorgen: 1.0,
    voorHetEerst: 0.5,
    primeur: 1.0,
    amusement: 0.5,
  },
};

const MAX_SCORE_LOKAAL = KERN_CRITERIA.reduce((som, id) => som + WEGING.kern[id] * 3, 0)
  + VERSTERKER_CRITERIA.reduce((som, id) => som + WEGING.versterker[id] * 3, 0);

const MAX_SCORE_LANDELIJK = MAX_SCORE_LOKAAL + WEGING.kern.lokaleRelevantie * 3;

// Drempel: onder deze score wordt geen pitch gemaakt. Laag genoeg voor
// recall (de sorteer op codescore doet de rest), hoog genoeg om routine
// en ruis te weren.
const DREMPEL = {
  lokaal: 6.0,
  landelijk: 8.0,
};

/**
 * Berekent de totaalscore uit de scores per criterium. De kern-versterker-regel
 * zit hier: als de kernscore 0 is, is de totaalscore 0, ongeacht de versterkers.
 */
function berekenScore(scores, categorie = "lokaal") {
  if (!scores || typeof scores !== "object") return 0;
  const kernIds = categorie === "landelijk"
    ? [...KERN_CRITERIA, "lokaleRelevantie"]
    : KERN_CRITERIA;

  const kernScore = kernIds.reduce((som, id) => {
    const score = Number(scores[id]) || 0;
    const weging = WEGING.kern[id] || 1.0;
    return som + score * weging;
  }, 0);

  if (kernScore === 0) return 0;

  const versterkerScore = VERSTERKER_CRITERIA.reduce((som, id) => {
    const score = Number(scores[id]) || 0;
    return som + score * WEGING.versterker[id];
  }, 0);

  return Math.round((kernScore + versterkerScore) * 10) / 10;
}

/** Geeft de criteria als tekst voor de prompt. Alleen landelijk krijgt lokaleRelevantie. */
function bouwCriteriaTekst(categorie = "lokaal") {
  const relevante = CRITERIA.filter((c) => !c.alleenLandelijk || categorie === "landelijk");
  return relevante
    .map((c) => {
      const ankers = Object.entries(c.ankers)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([score, tekst]) => `  ${score}: ${tekst}`)
        .join("\n");
      return `- ${c.naam} (${c.type}, ${c.boekpagina}): ${c.beschrijving}\n${ankers}`;
    })
    .join("\n\n");
}

function isKernCriterium(id) {
  return KERN_CRITERIA.includes(id) || id === "lokaleRelevantie";
}

function isVersterkerCriterium(id) {
  return VERSTERKER_CRITERIA.includes(id);
}

module.exports = {
  KERN_CRITERIA,
  VERSTERKER_CRITERIA,
  CRITERIA,
  WEGING,
  DREMPEL,
  MAX_SCORE_LOKAAL,
  MAX_SCORE_LANDELIJK,
  berekenScore,
  bouwCriteriaTekst,
  isKernCriterium,
  isVersterkerCriterium,
};
