// camera-reeks.js
//
// Cameratoezicht: besluiten van dezelfde plek aan elkaar knopen tot een REEKS
// (de eerste aanwijzing, extra camera's, verlengingen), en daarvan afleiden
// wat ZANP ermee doet. Alleen rekenwerk, geen netwerk en geen bestanden, zodat
// het te testen is.
//
// Dit vervangt de koppeling uit IbabsLos2 (scrape_besluiten.py). Daar werd een
// camera die was afgelopen naar de geschiedenis verplaatst, waardoor een
// verlenging na afloop een nieuwe reeks begon (Rode Zee, Elzenstraat stonden
// dubbel). Hier hoort een besluit bij een reeks als:
//   - de locatienaam overeenkomt (zonder "in/te <plaats>" en zonder
//     "aanwijzingsbesluit … cameratoezicht", zie locatieSleutel), en
//   - de plaats niet botst (is er geen plaats bekend, dan botst er niets), en
//   - het besluit begint hoogstens REEKS_MAX_GAT_DAGEN na het einde van de
//     reeks. Is er langer niets geweest, dan is het een nieuwe aanwijzing en
//     dus weer "de eerste keer".
//
// Wat ZANP met een reeks doet:
//   - rood: de eerste aanwijzing (volgnummer 1 en soort "aanwijzing") en het
//     ROOD_BIJ_NR-ste besluit in de reeks. De rest niet.
//   - agenda: de dag NA het einde van de reeks komt in de agenda, zodat je kijkt
//     of het is verlengd. Wordt het verlengd, dan schuift het item mee, want de
//     agenda wordt elke run opnieuw uit de reeksen afgeleid.
//   - pop-up: alle besluiten van de reeks, om tussen te navigeren.

"use strict";

const crypto = require("crypto");

const REEKS_MAX_GAT_DAGEN = 45;
// Het 5e besluit in een reeks (aanwijzing + vier keer verlengd of uitgebreid) is nieuws.
const ROOD_BIJ_NR = [5];

// Plaatsnamen in de gemeente Zaanstad (zelfde lijst als IbabsLos2).
const PLAATSEN = ["Koog aan de Zaan", "Zaandam", "Wormerveer", "Assendelft", "Krommenie", "Westzaan", "Zaandijk", "Wormer"];

const BESLUIT_WOORDEN = /aanwijzing(?:s)?besluit\s+(?:extra\s+)?(?:verlenging\s+)?(?:van\s+)?(?:tijdelijk\s+)?cameratoezicht\s*/gi;

/** "Aanwijzingsbesluit extra tijdelijk cameratoezicht X in Zaandam" → "extra". */
function soortVanTitel(titel) {
  const t = String(titel || "");
  if (/\bverlenging\b/i.test(t)) return "verlenging";
  if (/\bextra\b/i.test(t)) return "extra";
  return "aanwijzing";
}

function plaatsUit(tekst) {
  for (const p of PLAATSEN) {
    if (new RegExp(`(?:^|[^\\p{L}])${p.replace(/ /g, "\\s+")}(?![\\p{L}])`, "iu").test(String(tekst || ""))) return p;
  }
  return null;
}

/** De locatie in leesbare vorm: zonder besluitwoorden en zonder "in/te <plaats>". */
function locatieNaam(label, titel = "") {
  let l = String(label || "").replace(BESLUIT_WOORDEN, "");
  if (!l.trim()) l = String(titel || "").replace(BESLUIT_WOORDEN, "");
  l = l.replace(/\s+/g, " ").trim();
  l = l.replace(new RegExp(`\\s+(?:in|te)\\s+(?:${PLAATSEN.join("|")})\\b.*$`, "i"), "");
  return l.replace(/[\s,;:.]+$/g, "").trim();
}

/** De sleutel waarop locaties worden vergeleken: kleine letters, zonder accenten of leestekens. */
function locatieSleutel(label, titel = "") {
  return locatieNaam(label, titel)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Zelfde plek: gelijk, of de kortste is het begin van de langste ("perim" en
// "perim ingang een"). Geen losse deelstring: "kerk" hoort niet bij "kerkstraat".
function sleutelsPassen(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [kort, lang] = a.length <= b.length ? [a, b] : [b, a];
  return kort.length >= 4 && `${lang} `.startsWith(`${kort} `);
}

function plaatsPast(a, b) {
  return !a || !b || a === b;
}

function dagenTussen(vanDag, totDag) {
  const a = Date.parse(`${vanDag}T12:00:00Z`);
  const b = Date.parse(`${totDag}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function volgendeDagVan(dag, aantal = 1) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + aantal);
  return d.toISOString().slice(0, 10);
}

/**
 * Bouwt de reeksen uit alle bekende besluiten.
 *
 * @param {Array<{url, titel, camera, plaats, start, eind, soort, pubdate, redenCategorieen, redenSamenvatting}>} besluiten
 * @returns {Array<{id, locatie, plaats, start, eind, aantal, besluiten: Array}>}
 *          nieuwste eind eerst; per reeks de besluiten op volgorde van start (nr 1 t/m n)
 */
function bouwReeksen(besluiten) {
  const lijst = (besluiten || [])
    .filter((b) => b && b.url && b.start && b.eind)
    .sort((a, b) => a.start.localeCompare(b.start) || String(a.pubdate || "").localeCompare(String(b.pubdate || "")) || a.url.localeCompare(b.url));

  const reeksen = [];
  for (const b of lijst) {
    const sleutel = locatieSleutel(b.camera, b.titel);
    if (!sleutel) continue;
    const plaats = b.plaats || plaatsUit(b.titel) || plaatsUit(b.camera) || null;
    let beste = null;
    for (const r of reeksen) {
      if (!sleutelsPassen(r.sleutel, sleutel) || !plaatsPast(r.plaats, plaats)) continue;
      if (dagenTussen(r.eind, b.start) > REEKS_MAX_GAT_DAGEN) continue;
      if (!beste || r.eind > beste.eind) beste = r;
    }
    if (beste) {
      beste.lijst.push(b);
      if (b.eind > beste.eind) beste.eind = b.eind;
      if (!beste.plaats && plaats) beste.plaats = plaats;
    } else {
      reeksen.push({ sleutel, plaats, locatie: locatieNaam(b.camera, b.titel), start: b.start, eind: b.eind, lijst: [b] });
    }
  }

  return reeksen
    .map((r) => {
      const id = `cam-${crypto.createHash("sha1").update(`${r.sleutel}|${r.plaats || ""}|${r.start}`).digest("hex").slice(0, 10)}`;
      return {
        id,
        locatie: r.locatie,
        plaats: r.plaats,
        start: r.start,
        eind: r.eind,
        aantal: r.lijst.length,
        besluiten: r.lijst.map((b, i) => ({
          nr: i + 1,
          url: b.url,
          soort: b.soort || soortVanTitel(b.titel),
          titel: b.titel,
          start: b.start,
          eind: b.eind,
          pubdate: b.pubdate || null,
          redenCategorieen: b.redenCategorieen || [],
          redenSamenvatting: b.redenSamenvatting || null,
        })),
      };
    })
    .sort((a, b) => b.eind.localeCompare(a.eind) || a.id.localeCompare(b.id));
}

/** "Elzenstraat (Wormerveer)" of "Elzenstraat". */
function locatieMetPlaats(reeks) {
  return reeks.plaats ? `${reeks.locatie} (${reeks.plaats})` : reeks.locatie;
}

/**
 * Geeft de reeks en het besluit bij een url, of null.
 * @returns {{ reeks, besluit } | null}
 */
function vindBesluit(reeksen, url) {
  for (const reeks of reeksen || []) {
    const besluit = reeks.besluiten.find((b) => b.url === url);
    if (besluit) return { reeks, besluit };
  }
  return null;
}

/**
 * Moet dit besluit rood zijn? De eerste aanwijzing, en het ROOD_BIJ_NR-ste
 * besluit. Geeft de reden of null. Een reeks waarvan het eerste bekende besluit
 * al een verlenging is (de aanwijzing viel voor onze startdatum) telt niet als
 * "eerste keer".
 */
function roodReden(reeks, besluit) {
  const plek = locatieMetPlaats(reeks);
  if (besluit.nr === 1 && besluit.soort === "aanwijzing") {
    return `Eerste aanwijzing van cameratoezicht op ${plek}`;
  }
  if (ROOD_BIJ_NR.includes(besluit.nr)) {
    return `${besluit.nr}e besluit voor cameratoezicht op ${plek} (aanwijzing, extra camera's of verlenging)`;
  }
  return null;
}

module.exports = {
  REEKS_MAX_GAT_DAGEN,
  ROOD_BIJ_NR,
  PLAATSEN,
  soortVanTitel,
  plaatsUit,
  locatieNaam,
  locatieSleutel,
  sleutelsPassen,
  bouwReeksen,
  locatieMetPlaats,
  vindBesluit,
  roodReden,
  volgendeDagVan,
};
