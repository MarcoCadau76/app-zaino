// ===== App Zaino — funzioni "pure" condivise da pagina e Worker =====
// Non toccano la pagina né la rete: ricevono dati e restituiscono dati.
// Questo file è usato in due modi:
//   - nella pagina: <script src="logica.js"> prima di app.js (le funzioni diventano globali);
//   - nel Worker:   import logica from "../logica.js"  (wrangler lo include nel pacchetto).
// Così la lista, il conteggio delle voci e le regole degli orari sono UNA sola copia.

const NOMI_GIORNI = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];

// Data -> "AAAA-MM-GG" usando l'ora LOCALE (toISOString userebbe UTC e
// tra mezzanotte e l'una darebbe il giorno sbagliato).
function formattaData(d) {
  const a = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const g = String(d.getDate()).padStart(2, "0");
  return `${a}-${m}-${g}`;
}

// "AAAA-MM-GG" -> Date a mezzanotte (ora locale). Inverso di formattaData.
function dataDaTesto(testo) {
  const [a, m, g] = testo.split("-").map(Number);
  return new Date(a, m - 1, g);
}

function giornoDopo(d) {
  const r = new Date(d);
  r.setDate(r.getDate() + 1); // gestisce da solo fine mese e fine anno
  return r;
}

// Restituisce il motivo per cui non c'è scuola, oppure null se c'è scuola.
function motivoNoScuola(data, config) {
  const iso = formattaData(data);
  const { inizio, fine } = config.anno_scolastico;
  if (iso < inizio || iso > fine) return "Fuori dall'anno scolastico";
  if (data.getDay() === 0) return "Domenica";
  for (const c of config.chiusure) {
    if (iso >= c.dal && iso <= c.al) return c.motivo;
  }
  return null;
}

function normalizzaOggetto(o) {
  if (typeof o === "string") return { nome: o, facoltativo: false };
  return { nome: o.nome, facoltativo: Boolean(o.facoltativo) };
}

function costruisciLista(data, config) {
  const giorno = NOMI_GIORNI[data.getDay()];
  const materie = config.orario[giorno] || [];
  const gruppi = [{ materia: "Ogni giorno", oggetti: config.sempre }, ...materie.map(m => ({
    materia: m,
    oggetti: config.materie[m] || []
  }))];

  return gruppi.map(g => ({
    materia: g.materia,
    oggetti: g.oggetti.map(normalizzaOggetto).map(o => ({ ...o, id: `${g.materia}|${o.nome}` }))
  }));
}

function contaObbligatori(lista, spuntati) {
  const obbligatori = lista.flatMap(g => g.oggetti).filter(o => !o.facoltativo);
  const fatti = obbligatori.filter(o => spuntati.includes(o.id));
  return { fatti: fatti.length, totale: obbligatori.length };
}

// Elenco delle voci obbligatorie non ancora spuntate: [{ materia, nome }, ...]
function vociMancanti(lista, spuntati) {
  return lista.flatMap(g => g.oggetti
    .filter(o => !o.facoltativo && !spuntati.includes(o.id))
    .map(o => ({ materia: g.materia, nome: o.nome })));
}

// Controlla gli orari e restituisce null se vanno bene, altrimenti il messaggio
// della PRIMA regola non rispettata. Regole:
//   - tutti gli orari tra le 19:00 e le 23:00 (estremi compresi);
//   - promemoria < avviso genitori <= fine solleciti;
//   - intervallo solleciti: intero tra 5 e 30 minuti.
// Le ore "HH:MM" si confrontano bene anche come stringhe ("21:00" < "22:00").
// Usata sia dalla pagina sia dal Worker: è la stessa copia per entrambi.
function erroreOrari(o) {
  const ORA_MIN = "19:00";
  const ORA_MAX = "23:00";
  if (!o || typeof o !== "object") return "Orari mancanti.";

  const campi = {
    promemoria: "Promemoria a Francesco",
    avviso_genitori: "Avviso ai genitori",
    fine_solleciti: "Solleciti fino alle"
  };
  for (const [campo, nome] of Object.entries(campi)) {
    const v = o[campo];
    if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
      return `${nome}: orario mancante o non valido.`;
    }
    if (v < ORA_MIN || v > ORA_MAX) {
      return `${nome}: deve essere tra le ${ORA_MIN} e le ${ORA_MAX} (hai messo ${v}).`;
    }
  }
  if (!(o.promemoria < o.avviso_genitori)) {
    return `L'avviso ai genitori (${o.avviso_genitori}) deve essere dopo il promemoria (${o.promemoria}).`;
  }
  if (!(o.avviso_genitori <= o.fine_solleciti)) {
    return `I solleciti (fino alle ${o.fine_solleciti}) non possono finire prima dell'avviso ai genitori (${o.avviso_genitori}).`;
  }
  const n = o.intervallo_solleciti_min;
  if (!Number.isInteger(n) || n < 5 || n > 30) {
    return "Solleciti ogni: deve essere un numero intero di minuti tra 5 e 30.";
  }
  if (typeof o.avvisa_genitori_se_pronto !== "boolean") {
    return "Opzione \"Avvisami quando lo zaino è pronto\" non valida.";
  }
  return null;
}

// Nel browser "module" non esiste e questo blocco viene saltato;
// nel Worker (e nei test con Node) rende disponibili le funzioni.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NOMI_GIORNI, formattaData, dataDaTesto, giornoDopo, motivoNoScuola,
    normalizzaOggetto, costruisciLista, contaObbligatori, vociMancanti, erroreOrari
  };
}
