// ===== App Zaino — passo 2: stato condiviso sul Worker =====

// Indirizzo del Worker Cloudflare (pubblicato con wrangler dalla cartella worker/).
const API_URL = "https://zaino.zaino-worker.workers.dev";

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

// Per i test: ?oggi=2026-12-22 fa finta che oggi sia il 22 dicembre.
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

// ---------- Codice famiglia (resta salvato su ogni telefono) ----------

function leggiCodice() {
  try {
    return localStorage.getItem("codice-famiglia");
  } catch {
    return null;
  }
}

function salvaCodice(codice) {
  try {
    if (codice) localStorage.setItem("codice-famiglia", codice);
    else localStorage.removeItem("codice-famiglia");
  } catch {
    // storage non disponibile
  }
}

// ---------- Stato: ora vive sul Worker, condiviso tra i telefoni ----------

async function chiamaApi(metodo, data, corpo) {
  const risposta = await fetch(`${API_URL}/stato?data=${formattaData(data)}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", "X-Codice": leggiCodice() || "" },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  if (risposta.status === 401) throw new Error("codice");
  if (!risposta.ok) throw new Error(`Errore del server (${risposta.status})`);
  return risposta.json();
}

async function caricaStato(data) {
  const s = await chiamaApi("GET", data);
  return { spuntati: s.spuntati, chiuso: s.chiuso };
}

async function salvaStato(data, stato) {
  try {
    await chiamaApi("POST", data, stato);
  } catch (e) {
    mostraErrore("Salvataggio non riuscito: controlla la connessione e riprova.");
  }
}

// ---------- Disegno della pagina ----------

function mostraErrore(messaggio) {
  let el = document.getElementById("errore");
  if (!el) {
    el = document.createElement("p");
    el.id = "errore";
    el.className = "errore";
    document.getElementById("app").prepend(el);
  }
  el.textContent = messaggio;
}

function chiediCodice(messaggio) {
  const app = document.getElementById("app");
  app.innerHTML = `<h1>Codice famiglia</h1>
    <p>${messaggio}</p>
    <input id="codice" type="password" autocomplete="off">
    <button id="entra">Entra</button>`;
  document.getElementById("entra").addEventListener("click", () => {
    salvaCodice(document.getElementById("codice").value.trim());
    avvia();
  });
}

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

// Ogni modifica: aggiorno subito la pagina, poi salvo sul server.
// Così l'app resta reattiva anche se la rete è lenta.
function collegaEventi(config, domani, stato) {
  const aggiorna = () => {
    disegna(config, domani, stato);
    salvaStato(domani, stato);
  };

  document.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      stato.spuntati = cb.checked
        ? [...stato.spuntati, id]
        : stato.spuntati.filter(x => x !== id);
      aggiorna();
    });
  });

  const chiudi = document.getElementById("chiudi");
  if (chiudi) chiudi.addEventListener("click", () => {
    stato.chiuso = true;
    aggiorna();
  });

  const riapri = document.getElementById("riapri");
  if (riapri) riapri.addEventListener("click", () => {
    stato.chiuso = false;
    aggiorna();
  });
}

// ---------- Avvio ----------

async function avvia() {
  const risposta = await fetch("config.json");
  const config = await risposta.json();
  const domani = giornoDopo(leggiOggi());

  if (motivoNoScuola(domani, config)) {
    disegna(config, domani, { spuntati: [], chiuso: false });
    return;
  }

  if (!leggiCodice()) {
    chiediCodice("Inserisci il codice famiglia per iniziare.");
    return;
  }

  try {
    const stato = await caricaStato(domani);
    disegna(config, domani, stato);
  } catch (e) {
    if (e.message === "codice") {
      salvaCodice(null);
      chiediCodice("Codice errato, riprova.");
    } else {
      document.getElementById("app").innerHTML =
        `<p class="errore">Impossibile caricare la lista: controlla la connessione.</p>`;
    }
  }
}

if (typeof document !== "undefined") avvia();
