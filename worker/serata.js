// ===== Sequenza serale (Fase 5): calcoli puri, senza KV né rete =====
// Il cron gira ogni minuto. Invece di salvare "ho già mandato il sollecito delle 21:10"
// (sarebbero scritture nel KV), ogni minuto ricalcolo dall'orologio cosa va mandato
// ADESSO: se il minuto corrente è quello del promemoria, di un sollecito o
// dell'avviso ai genitori. Stesso minuto = stessa risposta, quindi niente da ricordare.

import logica from "../logica.js";

const { formattaData, dataDaTesto, giornoDopo, costruisciLista, contaObbligatori } = logica;

// Finestra in cui possono cadere gli orari veri (stesse regole di erroreOrari).
export const INIZIO_FINESTRA = 19 * 60;
export const FINE_FINESTRA = 23 * 60;

// Modalità di prova: la stessa sequenza compressa, in minuti dall'avvio della prova.
//   +1 promemoria, solleciti ogni 2 minuti (+3 +5 +7 +9), +4 avviso genitori, +9 ultimo.
export const PIANO_PROVA = { promemoria: 1, intervallo: 2, avviso: 4, fine: 9 };
export const DURATA_PROVA_MIN = 15; // la chiave di prova si cancella da sola dopo 15 minuti

// Ora italiana (fuso Europe/Rome, ora legale compresa) di un istante in millisecondi.
// Restituisce { data: "AAAA-MM-GG", ora: "HH:MM", minuti: minuti dalla mezzanotte }.
// Uso Intl perché il Worker (e il cron) ragionano in UTC.
const formatoRoma = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

export function oraRoma(ms) {
  const parti = Object.fromEntries(formatoRoma.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const ora = `${parti.hour}:${parti.minute}`;
  return {
    data: `${parti.year}-${parti.month}-${parti.day}`,
    ora,
    minuti: minutiDa(ora)
  };
}

// "21:30" -> 1290 (minuti dalla mezzanotte).
export function minutiDa(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// "AAAA-MM-GG" del giorno dopo (la sera si prepara lo zaino per domani).
export function domaniDi(dataTesto) {
  return formattaData(giornoDopo(dataDaTesto(dataTesto)));
}

// Orari salvati dai genitori ("HH:MM") -> piano in minuti dalla mezzanotte.
export function pianoDaOrari(orari) {
  return {
    promemoria: minutiDa(orari.promemoria),
    intervallo: orari.intervallo_solleciti_min,
    avviso: minutiDa(orari.avviso_genitori),
    fine: minutiDa(orari.fine_solleciti)
  };
}

// Cosa va mandato al minuto `t` secondo il piano (tutto in minuti, stessa scala).
// Restituisce un elenco, perché due eventi possono cadere nello stesso minuto
// (es. alle 21:30 sollecito a Francesco + avviso ai genitori):
//   "promemoria" -> a Francesco, all'orario del promemoria;
//   "sollecito"  -> a Francesco, ogni `intervallo` minuti dopo il promemoria, fino a `fine` compresa;
//   "avviso"     -> ai genitori, all'orario dell'avviso.
export function eventiSerata(t, piano) {
  const eventi = [];
  if (t === piano.promemoria) {
    eventi.push("promemoria");
  } else if (t > piano.promemoria && t <= piano.fine && (t - piano.promemoria) % piano.intervallo === 0) {
    eventi.push("sollecito");
  }
  if (t === piano.avviso) eventi.push("avviso");
  return eventi;
}

// Orari "HH:MM" della prova partita a `inizioMs`, da mostrare ai genitori.
export function orariProva(inizioMs) {
  const alle = minuti => oraRoma(inizioMs + minuti * 60000).ora;
  return {
    promemoria: alle(PIANO_PROVA.promemoria),
    avviso_genitori: alle(PIANO_PROVA.avviso),
    fine_solleciti: alle(PIANO_PROVA.fine),
    intervallo_solleciti_min: PIANO_PROVA.intervallo
  };
}

// Quante voci obbligatorie mancano nella lista di `dataTesto`.
export function riepilogo(dataTesto, config, spuntati) {
  const lista = costruisciLista(dataDaTesto(dataTesto), config);
  const { fatti, totale } = contaObbligatori(lista, spuntati);
  return { mancanti: totale - fatti, totale };
}

// "Manca 1 voce" / "Mancano 5 voci" (con la maiuscola se `inizio` è true).
function mancano(n, inizio) {
  const testo = n === 1 ? "manca 1 voce" : `mancano ${n} voci`;
  return inizio ? testo[0].toUpperCase() + testo.slice(1) : testo;
}

// Nome del giorno per i messaggi: "2026-11-27" -> "venerdì".
// Uso getDay (ora locale, coerente con dataDaTesto) invece di toLocaleDateString,
// che col fuso sbagliato potrebbe dare il giorno prima.
const GIORNI_CON_ACCENTO = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
function nomeGiorno(dataTesto) {
  return GIORNI_CON_ACCENTO[dataDaTesto(dataTesto).getDay()];
}

// Testo della notifica per un evento. `prova` aggiunge "(prova)" al titolo.
// Tag: i messaggi a Francesco si sostituiscono tra loro (niente pila di solleciti);
// lo stesso per quelli ai genitori.
export function messaggioEvento(evento, dataTesto, { mancanti, totale }, prova = false) {
  const suffisso = prova ? " (prova)" : "";
  const giorno = nomeGiorno(dataTesto);
  const cosaManca = mancanti === 0
    ? "La lista è completa: premi \"Zaino chiuso\"."
    : `${mancano(mancanti, true)} su ${totale}.`;

  switch (evento) {
    case "promemoria":
      return {
        titolo: `🎒 Prepara lo zaino${suffisso}`,
        testo: `È ora di preparare lo zaino per ${giorno}. ${cosaManca}`,
        tag: "zaino-francesco"
      };
    case "sollecito":
      return {
        titolo: `⏰ Lo zaino non è ancora chiuso${suffisso}`,
        testo: cosaManca,
        tag: "zaino-francesco"
      };
    case "avviso":
      return {
        titolo: `⚠️ Zaino non ancora pronto${suffisso}`,
        testo: mancanti === 0
          ? `Francesco ha spuntato tutto ma non ha chiuso lo zaino per ${giorno}.`
          : `Per ${giorno} a Francesco ${mancano(mancanti, false)} su ${totale}.`,
        tag: "zaino-genitori"
      };
    case "pronto":
      return {
        titolo: `✅ Zaino pronto${suffisso}`,
        testo: `Francesco ha chiuso lo zaino per ${giorno}.`,
        tag: "zaino-genitori"
      };
    default:
      return null;
  }
}

// A chi va ogni evento.
export const DESTINATARI = {
  promemoria: "francesco",
  sollecito: "francesco",
  avviso: "genitore",
  pronto: "genitore"
};
