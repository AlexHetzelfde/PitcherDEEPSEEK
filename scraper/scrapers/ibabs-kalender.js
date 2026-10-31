// scrapers/ibabs-kalender.js
//
// Leest de vergader- en bijeenkomstenkalender van een iBabs Publieksportaal
// (bijvoorbeeld https://zaanstad.bestuurlijkeinformatie.nl/Calendar), in de
// "Lijst"-weergave die de pagina zelf meelevert: per dag een rij met de
// vergaderingen en bijeenkomsten van die dag.
//
//   <a class="calendar-item" href="/Agenda/Index/<guid>">
//     <div class="calendar-item-label">· <span class="calendar-item-location">(Zaal 1)</span>
//        <div class="calendar-item-subtitle">Titel van de bijeenkomst</div></div>
//     <div class="sr-only">donderdag 1 oktober 2026</div>
//     <div class="calendar-item-time">17:30 - 19:00</div>
//   </a>
//
// Beperking: de pagina toont één maand, de huidige. Een volgende maand wordt
// in de browser nageladen via een apart verzoek; dat is een latere
// verbetering. Voor de agenda betekent het dat de laatste dagen van de maand
// weinig vooruitblik geven.
//
// De datum krijgt de echte begintijd (en eindtijd als eindDatum), zodat de
// agenda de tijd als vaststaand toont en niet als schatting.

const cheerio = require("cheerio");
const { haalOp, haalDatumUitTekst, kalenderdagAmsterdam, maakAbsoluut } = require("../hulpmiddelen");

const TZ = "Europe/Amsterdam";
const MAX_LOCATIE_TEKENS = 80;

function opschonen(tekst) {
  return String(tekst || "").replace(/\s+/g, " ").trim();
}

// Amsterdamse kalenderdag (JJJJ-MM-DD) + klok → ISO (UTC); rekent zomer- en wintertijd uit.
function amsterdamNaarIso(dag, uur, minuut) {
  const [j, m, d] = dag.split("-").map(Number);
  const gok = Date.UTC(j, m - 1, d, uur, minuut);
  const getoond = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(gok));
  const [datumDeel, tijdDeel] = getoond.split(" ");
  const [uj, um, ud] = datumDeel.split("-").map(Number);
  const [uu, umin] = tijdDeel.split(":").map(Number);
  const verschil = Date.UTC(uj, um - 1, ud, uu, umin) - gok;
  return new Date(gok - verschil).toISOString();
}

function dagPlus(dag, n) {
  const d = new Date(`${dag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * "17:30 - 19:00" → { start: [17,30], eind: [19,0] }.
 * Een eindtijd van 00:00 (of eerder dan de start) is middernacht, dus de
 * volgende dag. Een start van 23:59 gebruikt iBabs voor "hele dag"
 * (bijvoorbeeld reces): dan is er geen tijd.
 */
function leesTijd(tekst) {
  const m = opschonen(tekst).match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = [Number(m[1]), Number(m[2])];
  const eind = [Number(m[3]), Number(m[4])];
  if (start[0] > 23 || start[1] > 59 || eind[0] > 23 || eind[1] > 59) return null;
  if (start[0] === 23 && start[1] === 59) return null;
  return { start, eind };
}

/** "(Zaal 1 (diner zaal 7))" → "Zaal 1 (diner zaal 7)"; te lange of rommelige locaties worden ingekort. */
function schoneLocatie(tekst) {
  let t = opschonen(tekst);
  const m = t.match(/^\((.*)\)$/s);
  if (m) t = m[1].trim();
  if (t.length > MAX_LOCATIE_TEKENS) t = `${t.slice(0, MAX_LOCATIE_TEKENS).replace(/\s+\S*$/, "")}…`;
  return t;
}

/** Leest de agenda-items uit de al geladen pagina. */
function leesKalender($, bron, paginaUrl) {
  const berichten = [];
  $("a.calendar-item").each((_, a) => {
    const el = $(a);
    const href = el.attr("href");
    if (!href) return;

    const label = el.find(".calendar-item-label").first().clone();
    const locatie = schoneLocatie(label.find(".calendar-item-location").text());
    const ondertitel = opschonen(label.find(".calendar-item-subtitle").text());
    label.find(".calendar-item-location, .calendar-item-subtitle").remove();
    // iBabs zet een "·" op de plek van een lege kop; alleen echte tekst telt.
    const kop = opschonen(label.text()).replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const titel = kop && ondertitel ? `${kop}: ${ondertitel}` : kop || ondertitel;
    if (!titel) return;

    const dagIso = haalDatumUitTekst(el.find(".sr-only").text());
    const dag = kalenderdagAmsterdam(dagIso);
    if (!dag) return;

    const tijd = leesTijd(el.find(".calendar-item-time").text());
    let gepubliceerdOp = amsterdamNaarIso(dag, 0, 0);
    let eindDatum = null;
    if (tijd) {
      gepubliceerdOp = amsterdamNaarIso(dag, tijd.start[0], tijd.start[1]);
      const eindDag = tijd.eind[0] * 60 + tijd.eind[1] <= tijd.start[0] * 60 + tijd.start[1] ? dagPlus(dag, 1) : dag;
      eindDatum = amsterdamNaarIso(eindDag, tijd.eind[0], tijd.eind[1]);
    }

    berichten.push({
      bronId: bron.id,
      bronNaam: bron.naam,
      categorie: bron.categorie,
      titel,
      url: maakAbsoluut(href, paginaUrl),
      samenvatting: locatie ? `Locatie: ${locatie}.` : "",
      gepubliceerdOp,
      ...(eindDatum ? { eindDatum } : {}),
      opgehaaldOp: new Date().toISOString(),
    });
  });
  return berichten;
}

async function scrapeIbabsKalender(bron) {
  const html = await haalOp(bron.url);
  const berichten = leesKalender(cheerio.load(html), bron, bron.url);
  if (berichten.length === 0) {
    console.warn(`[${bron.id}] Geen agenda-items gevonden op ${bron.url}; de opmaak van het portaal is waarschijnlijk veranderd.`);
  }
  return berichten;
}

module.exports = { scrapeIbabsKalender, leesKalender, leesTijd };
