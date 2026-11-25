// ===== App Zaino — Fase 2: ruoli (Francesco / Genitore), annulla serata, orari =====

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

// Elenco delle voci obbligatorie non ancora spuntate: [{ materia, nome }, ...]
function vociMancanti(lista, spuntati) {
  return lista.flatMap(g => g.oggetti
    .filter(o => !o.facoltativo && !spuntati.includes(o.id))
    .map(o => ({ materia: g.materia, nome: o.nome })));
}

// ---------- Codice di accesso (resta salvato su ogni telefono) ----------
// La chiave "codice-famiglia" resta la stessa della Fase 1: i telefoni già
// configurati continuano a funzionare se CODICE_FAMIGLIA = vecchio CODICE.

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

// ---------- Chiamate al Worker ----------

// Chiamata generica: percorso es. "/stato?data=2026-11-26".
// Errori: "codice" (401, codice non valido), "permesso" (403, serve il genitore).
async function chiamaApi(metodo, percorso, corpo) {
  const risposta = await fetch(`${API_URL}${percorso}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", "X-Codice": leggiCodice() || "" },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  if (risposta.status === 401) throw new Error("codice");
  if (risposta.status === 403) throw new Error("permesso");
  if (!risposta.ok) throw new Error(`Errore del server (${risposta.status})`);
  return risposta.json();
}

function conData(percorso, data) {
  return `${percorso}?data=${formattaData(data)}`;
}

// Chiede al Worker chi sono: "francesco" o "genitore".
async function caricaRuolo() {
  const r = await chiamaApi("GET", "/sessione");
  return r.ruolo;
}

async function caricaStato(data) {
  const s = await chiamaApi("GET", conData("/stato", data));
  return { spuntati: s.spuntati, chiuso: s.chiuso, annullata: s.annullata };
}

// I salvataggi partono in fila, uno dopo l'altro: così due spunte rapide
// non possono arrivare al server in ordine invertito.
let codaSalvataggi = Promise.resolve();

function salvaStato(data, stato) {
  const copia = { spuntati: [...stato.spuntati], chiuso: stato.chiuso };
  codaSalvataggi = codaSalvataggi
    .then(() => chiamaApi("POST", conData("/stato", data), copia))
    .then(() => nascondiErrore())
    .catch(() => mostraErrore("Salvataggio non riuscito: controlla la connessione e riprova."));
  return codaSalvataggi;
}

async function impostaSerata(data, annullata) {
  return chiamaApi("POST", conData("/serata", data), { annullata });
}

async function caricaOrari() {
  const r = await chiamaApi("GET", "/orari");
  return r.orari;
}

async function salvaOrari(orari) {
  const r = await chiamaApi("POST", "/orari", orari);
  return r.orari;
}

// ---------- Messaggi d'errore (spazio fisso sopra l'app) ----------

function mostraErrore(messaggio) {
  const el = document.getElementById("errore");
  el.textContent = messaggio;
  el.hidden = false;
}

function nascondiErrore() {
  document.getElementById("errore").hidden = true;
}

// ---------- Schermata: inserimento codice ----------

function chiediCodice(messaggio) {
  const app = document.getElementById("app");
  app.innerHTML = `<h1>Codice di accesso</h1>
    <p>${messaggio}</p>
    <form id="form-codice">
      <input id="codice" type="password" autocomplete="off">
      <button type="submit">Entra</button>
    </form>`;
  // Con un form funziona anche il tasto "Invio" della tastiera.
  document.getElementById("form-codice").addEventListener("submit", ev => {
    ev.preventDefault();
    salvaCodice(document.getElementById("codice").value.trim());
    avvia();
  });
}

// Tasto in fondo alla pagina per cambiare codice (utile anche per i test).
function htmlEsci() {
  return `<button id="esci" class="secondario">Cambia codice</button>`;
}

function collegaEsci() {
  const esci = document.getElementById("esci");
  if (esci) esci.addEventListener("click", () => {
    salvaCodice(null);
    avvia();
  });
}

function titoloData(data) {
  return data.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
}

// ---------- Schermata Francesco: la checklist ----------

function disegnaFrancesco(config, domani, stato) {
  const app = document.getElementById("app");
  const titolo = titoloData(domani);

  const motivo = motivoNoScuola(domani, config);
  if (motivo) {
    app.innerHTML = `<h1>Domani, ${titolo}</h1><p class="riposo">Niente scuola: ${motivo} 🎉</p>${htmlEsci()}`;
    collegaEsci();
    return;
  }

  if (stato.annullata) {
    app.innerHTML = `<h1>Domani, ${titolo}</h1>
      <p class="riposo">Niente zaino stasera: domani niente scuola 🎉</p>${htmlEsci()}`;
    collegaEsci();
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
  html += htmlEsci();

  app.innerHTML = html;
  collegaEventiFrancesco(config, domani, stato);
}

// Ogni modifica: aggiorno subito la pagina, poi salvo sul server.
// Così l'app resta reattiva anche se la rete è lenta.
function collegaEventiFrancesco(config, domani, stato) {
  const aggiorna = () => {
    disegnaFrancesco(config, domani, stato);
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

  collegaEsci();
}

// ---------- Schermata Genitore: stato, annulla serata, orari ----------

function htmlStatoGenitore(config, domani, stato) {
  const motivo = motivoNoScuola(domani, config);
  if (motivo) return `<p class="riposo">Niente scuola: ${motivo}</p>`;

  if (stato.annullata) {
    return `<p class="riposo">Serata annullata: niente notifiche stasera.</p>
      <button id="ripristina">Ripristina serata</button>`;
  }

  const lista = costruisciLista(domani, config);
  const mancanti = vociMancanti(lista, stato.spuntati);
  let html;
  if (stato.chiuso) {
    html = `<p class="pronto">Zaino chiuso ✅</p>`;
  } else if (mancanti.length === 0) {
    html = `<p class="progresso">Lista completa, zaino non ancora chiuso.</p>`;
  } else {
    html = `<p class="progresso">Mancano ${mancanti.length} voci:</p><ul class="mancanti">`
      + mancanti.map(v => `<li>${v.materia}: ${v.nome}</li>`).join("")
      + `</ul>`;
  }
  html += `<button id="aggiorna" class="secondario">Aggiorna</button>
    <button id="annulla" class="pericolo">Domani niente scuola</button>`;
  return html;
}

function htmlOrari(orari) {
  return `<h2>Orari notifiche</h2>
    <form id="form-orari">
      <label class="campo">Promemoria a Francesco
        <input type="time" name="promemoria" value="${orari.promemoria}" required></label>
      <label class="campo">Solleciti ogni (minuti)
        <input type="number" name="intervallo_solleciti_min" min="5" max="60"
               value="${orari.intervallo_solleciti_min}" required></label>
      <label class="campo">Solleciti fino alle
        <input type="time" name="fine_solleciti" value="${orari.fine_solleciti}" required></label>
      <label class="campo">Avviso ai genitori alle
        <input type="time" name="avviso_genitori" value="${orari.avviso_genitori}" required></label>
      <label><input type="checkbox" name="avvisa_genitori_se_pronto"
        ${orari.avvisa_genitori_se_pronto ? "checked" : ""}> Avvisami quando lo zaino è pronto</label>
      <button type="submit">Salva orari</button>
    </form>`;
}

function disegnaGenitore(config, domani, stato, orari) {
  const app = document.getElementById("app");
  app.innerHTML = `<h1>Genitori · ${titoloData(domani)}</h1>
    ${htmlStatoGenitore(config, domani, stato)}
    ${htmlOrari(orari)}
    ${htmlEsci()}`;
  collegaEventiGenitore(config, domani, stato, orari);
}

function collegaEventiGenitore(config, domani, stato, orari) {
  const aggiorna = document.getElementById("aggiorna");
  if (aggiorna) aggiorna.addEventListener("click", () => avvia());

  // Annulla / ripristina: aggiorno lo stato locale solo se il server conferma.
  const cambiaSerata = async annullata => {
    try {
      await impostaSerata(domani, annullata);
      nascondiErrore();
      disegnaGenitore(config, domani, { ...stato, annullata }, orari);
    } catch (e) {
      mostraErrore("Operazione non riuscita: controlla la connessione e riprova.");
    }
  };

  const annulla = document.getElementById("annulla");
  if (annulla) annulla.addEventListener("click", () => {
    if (confirm("Domani niente scuola? Le notifiche di stasera verranno annullate.")) {
      cambiaSerata(true);
    }
  });

  const ripristina = document.getElementById("ripristina");
  if (ripristina) ripristina.addEventListener("click", () => cambiaSerata(false));

  document.getElementById("form-orari").addEventListener("submit", async ev => {
    ev.preventDefault();
    const f = ev.target.elements;
    const nuovi = {
      promemoria: f.promemoria.value,
      intervallo_solleciti_min: Number(f.intervallo_solleciti_min.value),
      fine_solleciti: f.fine_solleciti.value,
      avviso_genitori: f.avviso_genitori.value,
      avvisa_genitori_se_pronto: f.avvisa_genitori_se_pronto.checked
    };
    if (nuovi.promemoria >= nuovi.fine_solleciti) {
      mostraErrore("Il promemoria deve essere prima della fine dei solleciti.");
      return;
    }
    try {
      const salvati = await salvaOrari(nuovi);
      nascondiErrore();
      disegnaGenitore(config, domani, stato, salvati);
      alert("Orari salvati ✅");
    } catch (e) {
      mostraErrore("Orari non salvati: controlla i valori e la connessione.");
    }
  });

  collegaEsci();
}

// ---------- Avvio ----------

async function avvia() {
  nascondiErrore();
  const app = document.getElementById("app");

  let config;
  try {
    config = await (await fetch("config.json")).json();
  } catch {
    app.innerHTML = `<p class="errore">Impossibile caricare la configurazione: controlla la connessione.</p>`;
    return;
  }
  const domani = giornoDopo(leggiOggi());

  if (!leggiCodice()) {
    chiediCodice("Inserisci il codice di Francesco oppure quello dei genitori.");
    return;
  }

  try {
    const ruolo = await caricaRuolo();
    if (ruolo === "genitore") {
      const [stato, orari] = await Promise.all([caricaStato(domani), caricaOrari()]);
      disegnaGenitore(config, domani, stato, orari);
    } else if (motivoNoScuola(domani, config)) {
      // Francesco, giorno senza scuola: non serve chiedere lo stato al server.
      disegnaFrancesco(config, domani, { spuntati: [], chiuso: false, annullata: false });
    } else {
      disegnaFrancesco(config, domani, await caricaStato(domani));
    }
  } catch (e) {
    if (e.message === "codice") {
      salvaCodice(null);
      chiediCodice("Codice errato, riprova.");
    } else {
      app.innerHTML = `<p class="errore">Impossibile caricare i dati: controlla la connessione.</p>`;
    }
  }
}

if (typeof document !== "undefined") avvia();
