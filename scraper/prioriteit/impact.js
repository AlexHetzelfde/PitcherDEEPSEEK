// prioriteit/impact.js
//
// De impactlijst: woorden die wijzen op iets wat veel mensen raakt of waar
// een besluit over valt. Dit is een benadering en bedoeld om bij te stellen:
// voeg woorden toe of haal ze weg zonder iets anders aan te passen.
//
// Categorieën (gewicht staat in score.js, IMPACT_GEWICHT):
//   orde         openbare orde, veiligheid, ongeluk, ontruiming, afsluiting
//   conflict     protest, bezwaar, onrust, rechtszaak
//   besluit      raad, motie, besluit, hoorzitting, inspraak
//   voorziening  school, zorg, vervoer, water, tunnels en bruggen
// "geld" (bedragen vanaf 100.000 euro) en "aantal" (20 of meer getroffenen)
// worden uit de tekst zelf gehaald, zie taal.js.
//
// Woorden hoeven niet gestemd te zijn: ze worden hier door dezelfde stemmer
// gehaald als de tekst.

"use strict";

const LIJSTEN = {
  orde: [
    "brand", "brandweer", "evacuatie", "evacueren", "ontruiming", "ontruimd", "afgesloten", "afsluiting",
    "stremming", "gestremd", "onveilig", "gewond", "gewonden", "slachtoffer", "slachtoffers", "overleden",
    "dode", "doden", "ongeluk", "ongeval", "explosie", "instorting", "ingestort", "storing", "noodverordening",
    "noodtoestand", "calamiteit", "alarm", "waarschuwing", "schade", "overlast", "wateroverlast",
    "stroomstoring", "lekkage", "vervuiling", "giftig", "stankoverlast",
  ],
  conflict: [
    "protest", "petitie", "boos", "woede", "verzet", "bezwaar", "bezwaren", "bezwaarmakers", "zorgen",
    "onrust", "kritiek", "handtekeningen", "actiegroep", "demonstratie", "rechtszaak", "klacht", "klachten",
    "omstreden", "ophef",
  ],
  besluit: [
    "gemeenteraad", "raadsvergadering", "raadsvoorstel", "motie", "moties", "amendement", "besluit",
    "stemming", "vaststellen", "vastgesteld", "inspraak", "insprekers", "inspreker", "hoorzitting",
    "zienswijze", "commissie", "coalitie", "oppositie", "begroting", "kadernota",
  ],
  voorziening: [
    "school", "scholen", "ziekenhuis", "zorg", "huisarts", "vervoer", "bus", "trein", "station", "stroom",
    "drinkwater", "verwarming", "riolering", "brug", "tunnel", "viaduct", "sluis", "kruispunt", "rotonde",
    "fietspad", "snelweg", "verkeer", "parkeren", "woningbouw",
  ],
};

// Samenstellingen eindigend op deze woorden tellen als voorziening
// (fietstunnel, voetgangersbrug).
const VOORZIENING_EINDE = ["tunnel", "brug", "school", "station", "viaduct"];

let kaart = null;

function bouwKaart() {
  // Lazy, om een kringverwijzing met taal.js te vermijden.
  const { stam, schoon } = require("./taal");
  const m = new Map();
  for (const [cat, woorden] of Object.entries(LIJSTEN)) {
    for (const w of woorden) {
      const s = stam(schoon(w));
      if (!m.has(s)) m.set(s, cat);
    }
  }
  const einden = VOORZIENING_EINDE.map((w) => stam(schoon(w)));
  return { m, einden };
}

function categorieVan(stamWoord) {
  if (!kaart) kaart = bouwKaart();
  const cat = kaart.m.get(stamWoord);
  if (cat) return cat;
  if (stamWoord.length >= 8 && kaart.einden.some((e) => stamWoord.endsWith(e))) return "voorziening";
  return null;
}

module.exports = { LIJSTEN, categorieVan };
