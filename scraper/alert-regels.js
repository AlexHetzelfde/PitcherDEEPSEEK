// alert-regels.js
//
// ZANP-fase 2 (2026-10-24). Wanneer wordt een bericht een ALERT (rode balk)
// of een "mogelijk groot"-melding (oranje)?
//
// PRINCIPE: de AI beoordeelt niet "is dit belangrijk", want dat is niet te
// controleren. De AI vult per bericht een checklist met feiten in (gevaar,
// evacuatie, aantal betrokkenen, bedrag, banen, bestuurlijke crisis). Dit
// bestand beslist met een beslistabel. Alles wat je wilt bijstellen staat
// in CONFIG hieronder. De reden die je in de balk ziet komt uit deze code,
// nooit van de AI.
//
// CATEGORIEËN
//   veiligheid  regio + tijdkritisch + (evacuatie of NL-Alert, gewonden of
//               doden, of gevaar met genoeg betrokkenen)
//   bestuur     regio + bestuurlijke crisis of besluit met groot gevolg
//   economie    regio + genoeg banen of een groot bedrag
//
// ROOD of ORANJE
//   veiligheid  rood als de bron officieel is OF minstens 2 bronnen het melden
//   bestuur     rood bij een bestuurlijke crisis uit een officiële bron, OF
//               bij minstens 2 bronnen; anders oranje
//   economie    rood bij minstens 2 bronnen; anders oranje
//   Een signaalbron (andere redactie) kan alleen rood meewerken in een
//   cluster van minstens 2 onafhankelijke bronnen; zie signaalMagRood.
//
// MODUS (env ALERT_MODUS): "log" (standaard) berekent en bewaart alleen een
// kandidaat; "aan" laat de frontend de balk tonen. Begin met "log".

const CONFIG = {
  drempels: {
    betrokkenen: 10,
    banen: 50,
    geldbedragEuro: 1_000_000,
  },
  // Hoe lang een alert zichtbaar blijft na het ontstaan, in uren.
  duurUren: { veiligheid: 6, bestuur: 24, economie: 24 },
  maxRood: 3,
  // "nooit": signaalbronnen tellen niet mee voor rood
  // "tweebronnen": alleen in een cluster van minstens 2 onafhankelijke bronnen
  // "altijd": een signaalbron mag zelf rood maken
  signaalMagRood: "tweebronnen",
};

// Plaatsen in Zaanstreek-Waterland. De AI bepaalt NIET of iets in de regio
// speelt; dat doet deze lijst, op titel en tekst van de bron. Vul aan waar
// nodig (met kleine letters werkt het ook voor hoofdletters).
const REGIO_PLAATSEN = [
  "zaanstad", "zaandam", "zaandijk", "koog aan de zaan", "koog a/d zaan", "wormerveer", "krommenie", "assendelft",
  "westzaan", "zaanstreek", "oostzaan", "wormerland", "wormer", "jisp", "neck", "landsmeer", "waterland",
  "purmerend", "edam", "volendam", "edam-volendam", "monnickendam", "marken", "broek in waterland",
  "beemster", "de zaanse schans", "zaanse schans", "rooswijk", "kogerveld", "poelenburg", "peldersveld",
];

const REGIO_REGEX = new RegExp(
  `(?<![\\p{L}])(?:${REGIO_PLAATSEN.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`,
  "iu"
);

function isRegio(tekst) {
  return REGIO_REGEX.test(String(tekst ?? ""));
}

function uurNa(isoStart, uren) {
  return new Date(new Date(isoStart).getTime() + uren * 3600 * 1000).toISOString();
}

/**
 * Beoordeelt één bericht.
 *
 * @param {object} record     bericht met record.checklist en record.herkomst
 * @param {object} context    { aantalBronnen, heeftOfficieleBron }
 *                            over het hele cluster (minstens het bericht zelf)
 * @param {object} opties     { nu: Date, config }
 * @returns {{ niveau, categorie, reden, aangemaaktOp, tot } | null}
 */
function beoordeelAlert(record, context, opties = {}) {
  const c = record && record.checklist;
  if (!c) return null;
  const config = opties.config || CONFIG;
  const nu = (opties.nu || new Date()).toISOString();
  const d = config.drempels;
  const bronnen = Math.max(1, context.aantalBronnen || 1);
  const officieel = record.herkomst === "officieel" || context.heeftOfficieleBron === true;
  const alleenSignaal = !officieel && record.herkomst === "signaal";

  if (!c.inRegio) return null;

  const treffers = [];
  const toets = (categorie, redenen) => {
    if (redenen.length) treffers.push({ categorie, redenen });
  };

  // --- veiligheid
  const veiligheid = [];
  if (c.tijdkritisch) {
    if (c.evacuatieOfNlAlert) veiligheid.push("evacuatie of NL-Alert");
    if (c.gewondenOfDoden) veiligheid.push("gewonden of doden");
    if (c.gevaar && Number.isFinite(c.betrokkenen) && c.betrokkenen >= d.betrokkenen) {
      veiligheid.push(`gevaar voor ${c.betrokkenen} betrokkenen`);
    }
  }
  toets("veiligheid", veiligheid);

  // --- bestuur
  const bestuur = [];
  if (c.bestuurlijkeCrisis) bestuur.push("bestuurlijke crisis");
  if (c.besluitMetGrootGevolg) bestuur.push("besluit met groot gevolg");
  toets("bestuur", bestuur);

  // --- economie
  const economie = [];
  if (Number.isFinite(c.banen) && c.banen >= d.banen) economie.push(`${c.banen} banen`);
  if (Number.isFinite(c.geldbedragEuro) && c.geldbedragEuro >= d.geldbedragEuro) {
    economie.push(`bedrag van ${Math.round(c.geldbedragEuro / 100000) / 10} miljoen euro`);
  }
  toets("economie", economie);

  if (treffers.length === 0) return null;

  // De zwaarste categorie wint: veiligheid, dan bestuur, dan economie.
  const volgorde = ["veiligheid", "bestuur", "economie"];
  treffers.sort((a, b) => volgorde.indexOf(a.categorie) - volgorde.indexOf(b.categorie));
  const gekozen = treffers[0];

  let rood = false;
  if (gekozen.categorie === "veiligheid") rood = officieel || bronnen >= 2;
  else if (gekozen.categorie === "bestuur") rood = (c.bestuurlijkeCrisis && officieel) || bronnen >= 2;
  else rood = bronnen >= 2;

  // Signaalregel: een alert die alleen op signaalbronnen rust.
  if (rood && alleenSignaal) {
    if (config.signaalMagRood === "nooit") rood = false;
    else if (config.signaalMagRood === "tweebronnen" && bronnen < 2) rood = false;
  }

  const bronTekst = bronnen >= 2 ? `${bronnen} bronnen` : officieel ? "officiële bron" : "één bron";
  return {
    niveau: rood ? "rood" : "oranje",
    categorie: gekozen.categorie,
    reden: `${gekozen.redenen.join(", ")} (${bronTekst})`,
    aangemaaktOp: nu,
    tot: uurNa(nu, config.duurUren[gekozen.categorie] || 12),
  };
}

/**
 * Past de maximumregel toe: hoogstens config.maxRood rode alerts tegelijk
 * (de nieuwste blijven rood, de rest wordt oranje) en laat verlopen alerts
 * vervallen. Verwacht een lijst met { id, alert } en geeft id -> alert terug.
 */
function beperkAlerts(lijst, opties = {}) {
  const config = opties.config || CONFIG;
  const nu = (opties.nu || new Date()).getTime();
  const actief = lijst.filter((x) => x.alert && new Date(x.alert.tot).getTime() > nu);
  const rood = actief
    .filter((x) => x.alert.niveau === "rood")
    .sort((a, b) => (a.alert.aangemaaktOp < b.alert.aangemaaktOp ? 1 : -1));
  const uit = new Map();
  for (const x of actief) uit.set(x.id, x.alert);
  rood.slice(config.maxRood).forEach((x) => {
    uit.set(x.id, { ...x.alert, niveau: "oranje", reden: `${x.alert.reden}, maximum aan rode alerts bereikt` });
  });
  return uit;
}

module.exports = { CONFIG, REGIO_PLAATSEN, isRegio, beoordeelAlert, beperkAlerts };
