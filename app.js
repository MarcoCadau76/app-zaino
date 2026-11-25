// ===== App Zaino — passo 1: lista di domani (senza notifiche) =====

const NOMI_GIORNI = ["domenica", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato"];

// ---------- Funzioni "pure": non toccano la pagina, solo dati ----------

// Data -> "AAAA-MM-GG" usando l'ora LOCALE (toISOString userebbe UTC e
// tra mezzanotte e l'una darebbe il giorno sbagliato).
function formattaData(d) {
  const a = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const g = String(d.getDate()).padStart(2, "0");
  return `${a}-${m}-${g}`;
}

// Per i test: index.html?oggi=2026-12-22 fa finta che oggi sia il 22 dicembre.
function leggiOggi() {
  const param = new URLSearchParams(location.search).get("oggi");
  if (param) {
    const [a, m, g] = param.split("-").map(Number);
    return new Date(a, m - 1, g);
  }
  return new Date();
}

function giornoDopo(d) {
  const r = new Date(d);
  r.setDate(r.getDate() + 1); // gestisce da solo fine mese e fine anno
  return r;
}

// Restituisce il motivo per cui non c'è scuola, oppure null se c'è scuola.
// Le date "AAAA-MM-GG" si possono confrontare come stringhe: l'ordine
// alfabetico coincide con quello cronologico.
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

// Un oggetto può essere scritto come "Libro" oppure come
// { "nome": "Tastiera", "facoltativo": true }: qui li rendo tutti uguali.
function normalizzaOggetto(o) {
  if (typeof o === "string") return { nome: o, facoltativo: false };
  return { nome: o.nome, facoltativo: Boolean(o.facoltativo) };
}

// Costruisce la lista: [{ materia, oggetti: [{ id, nome, facoltativo }] }]
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

// Pronto = tutti gli oggetti NON facoltativi sono spuntati.
function contaObbligatori(lista, spuntati) {
  const obbligatori = lista.flatMap(g => g.oggetti).filter(o => !o.facoltativo);
  const fatti = obbligatori.filter(o => spuntati.includes(o.id));
  return { fatti: fatti.length, totale: obbligatori.length };
}

// ---------- Stato (per ora nel browser; poi passerà al server) ----------

function chiaveStato(data) {
  return `zaino-${formattaData(data)}`;
}

function caricaStato(data) {
  try {
    const salvato = localStorage.getItem(chiaveStato(data));
    return salvato ? JSON.parse(salvato) : { spuntati: [], chiuso: false };
  } catch {
    return { spuntati: [], chiuso: false };
  }
}

function salvaStato(data, stato) {
  try {
    localStorage.setItem(chiaveStato(data), JSON.stringify(stato));
  } catch {
    // storage non disponibile: lo stato resta solo in memoria
  }
}

// ---------- Disegno della pagina ----------

function disegna(config, domani, stato) {
  const app = document.getElementById("app");
  const titolo = domani.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });

  const motivo = motivoNoScuola(domani, config);
  if (motivo) {
    app.innerHTML = `<h1>Domani, ${titolo}</h1><p class="riposo">Niente scuola: ${motivo} 🎉</p>`;
    return;
  }

  const lista = costruisciLista(domani, config);
  const { fatti, totale } = contaObbligatori(lista, stato.spuntati);
  const completo = fatti === totale;

  let html = `<h1>Zaino per ${titolo}</h1>
    <p class="progresso">${fatti} / ${totale}</p>`;

  for (const gruppo of lista) {
    const tuttiFatti = gruppo.oggetti.every(o => o.facoltativo || stato.spuntati.includes(o.id));
    html += `<details open><summary>${tuttiFatti ? "✅" : "⬜"} ${gruppo.materia}</summary>`;
    for (const o of gruppo.oggetti) {
      const checked = stato.spuntati.includes(o.id) ? "checked" : "";
      const disabled = stato.chiuso ? "disabled" : "";
      html += `<label><input type="checkbox" data-id="${o.id}" ${checked} ${disabled}>
        ${o.nome}${o.facoltativo ? ' <em>(se serve)</em>' : ""}</label>`;
    }
    html += `</details>`;
  }

  if (stato.chiuso) {
    html += `<p class="pronto">Zaino chiuso ✅</p><button id="riapri">Riapri</button>`;
  } else {
    html += `<button id="chiudi" ${completo ? "" : "disabled"}>Zaino chiuso</button>`;
  }

  app.innerHTML = html;
  collegaEventi(config, domani, stato);
}

function collegaEventi(config, domani, stato) {
  document.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      stato.spuntati = cb.checked
        ? [...stato.spuntati, id]
        : stato.spuntati.filter(x => x !== id);
      salvaStato(domani, stato);
      disegna(config, domani, stato);
    });
  });

  const chiudi = document.getElementById("chiudi");
  if (chiudi) chiudi.addEventListener("click", () => {
    stato.chiuso = true;
    salvaStato(domani, stato);
    disegna(config, domani, stato);
  });

  const riapri = document.getElementById("riapri");
  if (riapri) riapri.addEventListener("click", () => {
    stato.chiuso = false;
    salvaStato(domani, stato);
    disegna(config, domani, stato);
  });
}

// ---------- Avvio ----------

async function avvia() {
  const risposta = await fetch("config.json");
  const config = await risposta.json();
  const domani = giornoDopo(leggiOggi());
  disegna(config, domani, caricaStato(domani));
}

if (typeof document !== "undefined") avvia();
