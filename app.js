// ===== App Zaino — schermate Francesco / Genitore, notifiche, prova della serata =====
// Le funzioni pure (lista, conteggi, date, regole degli orari) sono in logica.js,
// caricato prima di questo file e usato anche dal Worker.

// Indirizzo del Worker Cloudflare (pubblicato con wrangler dalla cartella worker/).
const API_URL = "https://zaino.zaino-worker.workers.dev";

// Dati della sessione corrente, condivisi dalle schermate (riempiti da avvia):
//   ruolo: "francesco" | "genitore"; vapid: chiave pubblica per le notifiche;
//   notifiche: stato su questo telefono (vedi leggiStatoNotifiche);
//   dispositivi: telefoni iscritti (solo schermata genitore).
//   erroreNotifiche: motivo esatto quando notifiche = "errore".
//   prova: prova della serata in corso (solo genitori), oppure null.
const sessione = { ruolo: null, vapid: null, notifiche: "non-supportate", erroreNotifiche: "", dispositivi: [], prova: null };

// ---------- Funzioni di supporto (le altre funzioni pure sono in logica.js) ----------

// Per i test: ?oggi=2026-12-22 fa finta che oggi sia il 22 dicembre.
// Senza parametro (o con un valore non valido) usa la data vera del telefono.
function leggiOggi() {
  const param = new URLSearchParams(location.search).get("oggi");
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) return dataDaTesto(param);
  return new Date();
}

// Chiave base64url (formato delle chiavi push) -> array di byte.
function base64UrlInBytes(testo) {
  const b64 = testo.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((testo.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Rende sicuro un testo da inserire nell'HTML (es. nomi arrivati dal server).
function escapa(testo) {
  const sostituzioni = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(testo).replace(/[&<>"']/g, c => sostituzioni[c]);
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
// Errori: "codice" (401, codice non valido), "permesso" (403, serve il genitore);
// per gli altri errori il messaggio è quello spiegato dal Worker nel campo "errore"
// (es. quale regola degli orari non è rispettata), se c'è.
async function chiamaApi(metodo, percorso, corpo) {
  const risposta = await fetch(`${API_URL}${percorso}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", "X-Codice": leggiCodice() || "" },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  if (risposta.status === 401) throw new Error("codice");
  if (risposta.status === 403) throw new Error("permesso");
  if (!risposta.ok) {
    let messaggio = `Errore del server (${risposta.status})`;
    try {
      const dati = await risposta.json();
      if (dati.errore) messaggio = dati.errore;
    } catch {
      // risposta non in JSON: resta il messaggio generico
    }
    throw new Error(messaggio);
  }
  return risposta.json();
}

function conData(percorso, data) {
  return `${percorso}?data=${formattaData(data)}`;
}

// Chiede al Worker chi sono ("francesco" o "genitore") e la chiave
// pubblica VAPID necessaria per iscriversi alle notifiche.
async function caricaSessione() {
  const r = await chiamaApi("GET", "/sessione");
  return { ruolo: r.ruolo, vapid: r.vapid };
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

// Orari delle notifiche e, nella stessa risposta, l'eventuale prova della serata
// in corso: { orari, prova } (prova = null se non c'è).
async function caricaOrari() {
  const r = await chiamaApi("GET", "/orari");
  return { orari: r.orari, prova: r.prova || null };
}

async function salvaOrari(orari) {
  const r = await chiamaApi("POST", "/orari", orari);
  return r.orari;
}

// Manda al Worker l'iscrizione push di questo telefono (il ruolo lo decide
// il Worker dal codice). Se è identica a quella salvata, il Worker non scrive.
async function inviaIscrizione(iscrizione) {
  return chiamaApi("POST", "/iscrizione", { iscrizione: iscrizione.toJSON(), dispositivo: nomeDispositivo() });
}

// Solo genitori: elenco dei telefoni iscritti alle notifiche.
async function caricaDispositivi() {
  const r = await chiamaApi("GET", "/iscrizioni");
  return r.dispositivi;
}

// Solo genitori: notifica di prova. destinatari = "tutti" | "francesco" | "genitore".
async function inviaProva(destinatari) {
  const r = await chiamaApi("POST", "/prova", { destinatari });
  return r.esiti;
}

// Solo genitori: avvia (attiva = true) o ferma la prova della serata per la lista
// di `data`. Restituisce la prova con gli orari "HH:MM", oppure null se fermata.
async function impostaProvaSerata(data, attiva) {
  const r = await chiamaApi("POST", conData("/prova-serata", data), { attiva });
  return r.prova;
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

// ---------- Installazione come app (PWA) ----------

// true se l'app è aperta dall'icona sulla Home (non dentro Safari/Chrome).
function eInstallata() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true; // vecchio modo di iOS
}

// true su iPhone/iPad (gli iPad recenti si presentano come "Macintosh" con touch).
function eIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

// Suggerimento mostrato solo se l'app è aperta nel browser e non installata,
// con i menu del browser in uso. Su Samsung Internet conviene attivare le notifiche
// QUI, nella scheda, prima di installare: nell'app installata la richiesta
// del permesso può non comparire (il permesso poi vale anche per l'app).
function htmlSuggerimentoInstallazione() {
  if (eInstallata()) return "";
  let istruzioni;
  switch (browserInUso()) {
    case "ios":
      istruzioni = "In Safari tocca <b>Condividi</b> (il quadrato con la freccia) → <b>Aggiungi alla schermata Home</b>. "
        + "Su iPhone le notifiche funzionano solo dall'app installata.";
      break;
    case "samsung":
      istruzioni = "Prima tocca qui sotto <b>Attiva notifiche</b> e scegli <b>Consenti</b>; "
        + "poi menu <b>≡</b> → <b>Aggiungi pagina a</b> → <b>Schermata Home</b>.";
      break;
    default:
      istruzioni = "Nel menu del browser (⋮) tocca <b>Installa app</b> oppure <b>Aggiungi a schermata Home</b>.";
  }
  return `<p class="installa">📲 Installa l'app per ricevere i promemoria. ${istruzioni}
    Dopo l'installazione aprila dall'icona e, se lo chiede, reinserisci il codice.</p>`;
}

// ---------- Notifiche push (Fase 4) ----------

// Nome del telefono mostrato ai genitori nell'elenco degli iscritti.
function nomeDispositivo() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Computer";
}

function pushSupportato() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

// Aspetta il service worker attivo, ma al massimo `ms` millisecondi
// (se la registrazione fosse fallita, "ready" non arriverebbe mai).
function serviceWorkerPronto(ms = 5000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rifiuta) => setTimeout(() => rifiuta(new Error("service worker non pronto")), ms))
  ]);
}

// Aspetta una promessa al massimo `ms` millisecondi; se non arriva risposta
// rifiuta con un errore che contiene `messaggio` (così nulla resta appeso).
function conTimeout(promessa, ms, messaggio) {
  let timer;
  const scadenza = new Promise((_, rifiuta) => {
    timer = setTimeout(() => rifiuta(new Error(messaggio)), ms);
  });
  return Promise.race([promessa, scadenza]).finally(() => clearTimeout(timer));
}

// Testo leggibile di un errore del browser, con nome e messaggio esatti
// (es. "AbortError: Registration failed - push service not available").
function testoErrore(e) {
  if (!e) return "errore sconosciuto";
  if (e.name && e.name !== "Error") return `${e.name}: ${e.message}`;
  return e.message || String(e);
}

// Browser usato: "ios", "samsung" (Samsung Internet), "chrome" o "altro".
// Serve solo a dare istruzioni con i menu giusti.
function browserInUso() {
  const ua = navigator.userAgent;
  if (eIos()) return "ios";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/Chrome/.test(ua)) return "chrome";
  return "altro";
}

// Dove si concede (o si riattiva) il permesso delle notifiche per il sito,
// con i menu del browser in uso. Il permesso vale per il sito, quindi anche
// per l'app installata.
function istruzioniPermesso() {
  switch (browserInUso()) {
    case "ios":
      return "Apri Impostazioni → Notifiche → Zaino e attiva \"Consenti notifiche\", poi riapri l'app.";
    case "samsung":
      return "Apri Samsung Internet → menu ≡ → Impostazioni → Siti e download → Notifiche: "
        + "attiva le richieste di notifica e imposta marcocadau76.github.io su \"Consenti\". "
        + "Controlla anche Impostazioni di Android → App → Samsung Internet → Notifiche. Poi riapri l'app.";
    case "chrome":
      return "Apri Chrome → ⋮ → Impostazioni → Impostazioni sito → Tutti i siti → marcocadau76.github.io "
        + "→ Notifiche → Consenti (e disattiva \"Usa messaggi più discreti\" in Impostazioni sito → Notifiche). "
        + "Poi riapri l'app.";
    default:
      return "Consenti le notifiche per marcocadau76.github.io nelle impostazioni del browser, poi riapri l'app.";
  }
}

// Stato delle notifiche su questo telefono:
//   "da-installare"  iPhone in Safari: le notifiche funzionano solo dall'app sulla Home;
//   "non-supportate" browser senza Web Push (o Worker senza chiavi);
//   "negate"         permesso rifiutato: si riattiva solo dalle impostazioni;
//   "da-attivare"    serve il tocco su "Attiva notifiche";
//   "attive"         iscritto: rimando l'iscrizione al Worker per tenerla allineata;
//   "errore"         controllo fallito: il motivo esatto va in sessione.erroreNotifiche.
async function leggiStatoNotifiche() {
  sessione.erroreNotifiche = "";
  try {
    if (eIos() && !eInstallata()) return "da-installare";
    if (!pushSupportato()) return "non-supportate";
    if (!sessione.vapid) {
      sessione.erroreNotifiche = "il server non ha fornito la chiave per le notifiche (VAPID).";
      return "errore";
    }
    if (Notification.permission === "denied") return "negate";
    if (Notification.permission !== "granted") return "da-attivare";

    const reg = await serviceWorkerPronto();
    const iscrizione = await reg.pushManager.getSubscription();
    if (!iscrizione) return "da-attivare";

    // Se l'iscrizione è stata fatta con una chiave VAPID diversa (chiavi rigenerate)
    // non funzionerebbe più: la cancello e chiedo di riattivare.
    const chiaveUsata = iscrizione.options && iscrizione.options.applicationServerKey;
    if (chiaveUsata) {
      const attuale = base64UrlInBytes(sessione.vapid);
      const usata = new Uint8Array(chiaveUsata);
      if (usata.length !== attuale.length || usata.some((b, i) => b !== attuale[i])) {
        await iscrizione.unsubscribe();
        return "da-attivare";
      }
    }

    inviaIscrizione(iscrizione).catch(() => {}); // in sottofondo, non blocca la pagina
    return "attive";
  } catch (e) {
    sessione.erroreNotifiche = testoErrore(e);
    return "errore";
  }
}

// Attivazione dopo il tocco sul tasto, in tre passaggi. Ogni passaggio ha un
// tempo massimo e viene raccontato con `passo(testo)`; se qualcosa va storto
// lancia un errore con un messaggio già pronto da mostrare.
// La richiesta del permesso deve essere la PRIMA cosa fatta dopo il tocco:
// iOS la blocca se prima ci sono attese.
async function attivaNotifiche(passo) {
  // 1. Permesso. Se è già concesso (es. dato da una scheda di Chrome) non lo
  //    richiedo: su Android la richiesta potrebbe restare appesa senza motivo.
  let permesso = Notification.permission;
  if (permesso === "granted") {
    passo("1/3 Permesso già concesso ✅");
  } else {
    passo("1/3 Richiesta del permesso…");
    try {
      permesso = await conTimeout(Notification.requestPermission(), 30000, "timeout-permesso");
    } catch (e) {
      if (e.message === "timeout-permesso") {
        // Caso tipico su Android (Chrome, Samsung Internet): richiesta "silenziosa"
        // o bloccata dalle impostazioni del browser, invisibile nell'app installata.
        // Il permesso si concede dalle impostazioni del browser e vale anche per l'app.
        throw new Error(
          `Il telefono non ha mostrato la richiesta di permesso entro 30 secondi `
          + `(stato del permesso: "${Notification.permission}"). ${istruzioniPermesso()} `
          + `Poi tocca di nuovo "Attiva notifiche".`
        );
      }
      throw new Error(`Richiesta del permesso non riuscita: ${testoErrore(e)}`);
    }
  }
  if (permesso === "denied") {
    sessione.notifiche = "negate";
    throw new Error(`Permesso negato. ${istruzioniPermesso()}`);
  }
  if (permesso !== "granted") {
    throw new Error("Hai chiuso la richiesta senza scegliere: tocca di nuovo il tasto e scegli \"Consenti\".");
  }

  // 2. Iscrizione al servizio push del telefono (Apple o Google).
  passo("2/3 Iscrizione al servizio di notifiche del telefono…");
  let iscrizione;
  try {
    const reg = await serviceWorkerPronto(10000);
    iscrizione = await reg.pushManager.getSubscription();
    if (!iscrizione) {
      iscrizione = await conTimeout(reg.pushManager.subscribe({
        userVisibleOnly: true, // obbligatorio: ogni push mostra una notifica
        applicationServerKey: base64UrlInBytes(sessione.vapid)
      }), 20000, "nessuna risposta dal servizio di notifiche entro 20 secondi");
    }
  } catch (e) {
    throw new Error(`Iscrizione non riuscita: ${testoErrore(e)}`);
  }

  // 3. Registrazione dell'iscrizione sul nostro Worker.
  passo("3/3 Registrazione sul server…");
  try {
    await conTimeout(inviaIscrizione(iscrizione), 15000, "il server non ha risposto entro 15 secondi");
  } catch (e) {
    const motivo = e.message === "Failed to fetch" ? "connessione assente" : testoErrore(e);
    throw new Error(`Registrazione sul server non riuscita: ${motivo}`);
  }
  sessione.notifiche = "attive";
}

// Riga sotto il tasto "Attiva notifiche": passaggio in corso (grigio) o errore (rosso).
function mostraEsitoNotifiche(testo, errore) {
  const el = document.getElementById("esito-notifiche");
  if (!el) return;
  el.textContent = testo;
  el.className = errore ? "errore" : "nota";
  el.hidden = false;
}

// Riga sulle notifiche mostrata in fondo a ogni schermata.
function htmlNotifiche() {
  switch (sessione.notifiche) {
    case "attive":
      return `<p class="nota">🔔 Notifiche attive su questo telefono.</p>`;
    case "da-attivare":
      return `<button id="attiva-notifiche">🔔 Attiva notifiche</button>
        <p id="esito-notifiche" hidden></p>`;
    case "negate":
      return `<p class="nota">🔕 Notifiche bloccate. ${istruzioniPermesso()}</p>`;
    case "da-installare":
      return ""; // ci pensa il suggerimento di installazione
    case "errore":
      return `<p class="errore" id="esito-notifiche">Notifiche: ${escapa(sessione.erroreNotifiche)}</p>`;
    default:
      return `<p class="nota">Notifiche non disponibili su questo browser.</p>`;
  }
}

// Fondo pagina: suggerimento di installazione (se serve), stato delle
// notifiche e tasto per cambiare codice (utile anche per i test).
function htmlEsci() {
  return `${htmlSuggerimentoInstallazione()}
    ${htmlNotifiche()}
    <button id="esci" class="secondario">Cambia codice</button>`;
}

// Collega i tasti del fondo pagina: "Cambia codice" e "Attiva notifiche".
function collegaEsci() {
  const esci = document.getElementById("esci");
  if (esci) esci.addEventListener("click", () => {
    salvaCodice(null);
    avvia();
  });

  // "Attiva notifiche": sotto il tasto racconto ogni passaggio; in caso di
  // errore mostro il motivo esatto e riattivo il tasto per riprovare.
  const attiva = document.getElementById("attiva-notifiche");
  if (attiva) attiva.addEventListener("click", async () => {
    attiva.disabled = true;
    try {
      await attivaNotifiche(testo => mostraEsitoNotifiche(testo, false));
      avvia(); // ridisegno: comparirà "Notifiche attive su questo telefono"
    } catch (e) {
      mostraEsitoNotifiche(e.message, true);
      attiva.disabled = false;
    }
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

// Modulo degli orari. "novalidate" spegne i controlli del browser (messaggi
// generici e diversi tra iPhone e Android): controlla tutto erroreOrari, che
// spiega quale regola non è rispettata. L'esito compare dentro il riquadro.
// I campi sono nell'ordine in cui avvengono: promemoria, avviso, fine solleciti.
function htmlOrari(orari) {
  return `<h2>Orari notifiche</h2>
    <form id="form-orari" novalidate>
      <p class="nota">Tutti gli orari tra le 19:00 e le 23:00.</p>
      <label class="campo">Promemoria a Francesco
        <input type="time" name="promemoria" value="${orari.promemoria}"></label>
      <label class="campo">Avviso ai genitori alle
        <input type="time" name="avviso_genitori" value="${orari.avviso_genitori}"></label>
      <label class="campo">Solleciti fino alle
        <input type="time" name="fine_solleciti" value="${orari.fine_solleciti}"></label>
      <label class="campo">Solleciti ogni (minuti)
        <input type="number" name="intervallo_solleciti_min" min="5" max="30" step="1"
               inputmode="numeric" value="${orari.intervallo_solleciti_min}"></label>
      <label><input type="checkbox" name="avvisa_genitori_se_pronto"
        ${orari.avvisa_genitori_se_pronto ? "checked" : ""}> Avvisami quando lo zaino è pronto</label>
      <p id="esito-orari" hidden></p>
      <button type="submit">Salva orari</button>
    </form>`;
}

// Mostra l'esito del salvataggio orari dentro il riquadro (ok = verde, altrimenti rosso).
function mostraEsitoOrari(testo, ok) {
  const el = document.getElementById("esito-orari");
  el.textContent = testo;
  el.className = ok ? "pronto" : "errore";
  el.hidden = false;
}

// Sezione notifiche dei genitori: telefoni iscritti, notifica di prova
// e prova della sequenza serale.
function htmlSezioneNotifiche() {
  const nomeRuolo = r => (r === "genitore" ? "genitore" : "Francesco");
  const elenco = sessione.dispositivi.length === 0
    ? `<p class="nota">Nessun telefono iscritto alle notifiche.</p>`
    : `<ul class="mancanti">${sessione.dispositivi
        .map(d => `<li>${escapa(d.dispositivo)} · ${nomeRuolo(d.ruolo)}</li>`).join("")}</ul>`;
  return `<h2>Notifiche</h2>
    <p class="nota">Telefoni iscritti:</p>
    ${elenco}
    <label class="campo">Notifica di prova a
      <select id="destinatari">
        <option value="tutti">tutti</option>
        <option value="francesco">Francesco</option>
        <option value="genitore">genitori</option>
      </select></label>
    <button id="prova" class="secondario">Invia notifica di prova</button>
    <ul id="esiti-prova" class="mancanti" hidden></ul>
    ${htmlProvaSerata()}`;
}

// Prova della sequenza serale: la stessa logica della sera vera (lista di domani,
// serata annullata, zaino chiuso) ma con gli orari compressi in 10 minuti.
// Se è in corso mostro gli orari esatti e il tasto per fermarla.
function htmlProvaSerata() {
  const p = sessione.prova;
  const intestazione = `<h2>Prova della serata</h2>`;
  const esito = `<p id="esito-prova" hidden></p>`;
  if (p) {
    return `${intestazione}
      <p class="nota">Prova in corso per la lista di ${titoloData(dataDaTesto(p.data))}:
        promemoria alle <b>${p.promemoria}</b>, solleciti ogni ${p.intervallo_solleciti_min} minuti
        fino alle <b>${p.fine_solleciti}</b>, avviso ai genitori alle <b>${p.avviso_genitori}</b>.
        Se Francesco chiude lo zaino i solleciti si fermano e arriva "Zaino pronto".</p>
      <button id="ferma-prova" class="secondario">Ferma la prova</button>
      ${esito}`;
  }
  return `${intestazione}
    <p class="nota">Fa partire la sequenza vera in 10 minuti: promemoria dopo 1 minuto,
      solleciti ogni 2 minuti, avviso ai genitori dopo 4. Usa la lista di domani:
      se lo zaino è già chiuso o la serata è annullata non arriva nulla (come la sera vera).</p>
    <button id="avvia-prova" class="secondario">Prova la sequenza (10 minuti)</button>
    ${esito}`;
}

function disegnaGenitore(config, domani, stato, orari) {
  const app = document.getElementById("app");
  app.innerHTML = `<h1>Genitori · ${titoloData(domani)}</h1>
    ${htmlStatoGenitore(config, domani, stato)}
    ${htmlOrari(orari)}
    ${htmlSezioneNotifiche()}
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

  // Salvataggio orari: controllo prima nella pagina (risposta immediata),
  // poi il Worker ricontrolla con la stessa regola e potrebbe comunque rifiutare.
  document.getElementById("form-orari").addEventListener("submit", async ev => {
    ev.preventDefault();
    const f = ev.target.elements;
    const testoIntervallo = f.intervallo_solleciti_min.value.trim();
    const nuovi = {
      promemoria: f.promemoria.value,
      avviso_genitori: f.avviso_genitori.value,
      fine_solleciti: f.fine_solleciti.value,
      // Campo vuoto -> NaN, così erroreOrari lo segnala (Number("") darebbe 0).
      intervallo_solleciti_min: testoIntervallo === "" ? NaN : Number(testoIntervallo),
      avvisa_genitori_se_pronto: f.avvisa_genitori_se_pronto.checked
    };

    const errore = erroreOrari(nuovi);
    if (errore) {
      mostraEsitoOrari(errore, false);
      return;
    }
    try {
      const salvati = await salvaOrari(nuovi);
      nascondiErrore();
      disegnaGenitore(config, domani, stato, salvati);
      mostraEsitoOrari("Orari salvati ✅", true);
    } catch (e) {
      // e.message: regola violata spiegata dal Worker, oppure errore di rete.
      const testo = e.message === "Failed to fetch" || e.message === "Load failed"
        ? "Orari non salvati: controlla la connessione."
        : `Orari non salvati: ${e.message}`;
      mostraEsitoOrari(testo, false);
    }
  });

  // Notifica di prova: mostro l'esito per ogni telefono (inviata, scaduta, rifiutata).
  const prova = document.getElementById("prova");
  prova.addEventListener("click", async () => {
    const elenco = document.getElementById("esiti-prova");
    prova.disabled = true;
    prova.textContent = "Invio in corso…";
    try {
      const esiti = await inviaProva(document.getElementById("destinatari").value);
      elenco.innerHTML = esiti.length === 0
        ? "<li>Nessun telefono iscritto per questi destinatari.</li>"
        : esiti.map(e => `<li>${escapa(e.dispositivo)} · ${e.ruolo === "genitore" ? "genitore" : "Francesco"}:
            ${escapa(e.esito)}${e.dettaglio ? ` <em>${escapa(e.dettaglio)}</em>` : ""}</li>`).join("");
    } catch (e) {
      elenco.innerHTML = `<li>Invio non riuscito: ${escapa(e.message)}</li>`;
    }
    elenco.hidden = false;
    prova.disabled = false;
    prova.textContent = "Invia notifica di prova";
  });

  // Prova della serata: avvio o arresto; se il Worker rifiuta (es. domani niente
  // scuola) il motivo compare sotto il tasto.
  const cambiaProva = async (tasto, attiva) => {
    tasto.disabled = true;
    try {
      sessione.prova = await impostaProvaSerata(domani, attiva);
      disegnaGenitore(config, domani, stato, orari);
    } catch (e) {
      const el = document.getElementById("esito-prova");
      el.textContent = `Prova non avviata: ${e.message}`;
      el.className = "errore";
      el.hidden = false;
      tasto.disabled = false;
    }
  };
  const avviaProva = document.getElementById("avvia-prova");
  if (avviaProva) avviaProva.addEventListener("click", () => cambiaProva(avviaProva, true));
  const fermaProva = document.getElementById("ferma-prova");
  if (fermaProva) fermaProva.addEventListener("click", () => cambiaProva(fermaProva, false));

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
    const { ruolo, vapid } = await caricaSessione();
    sessione.ruolo = ruolo;
    sessione.vapid = vapid;
    sessione.notifiche = await leggiStatoNotifiche();

    if (ruolo === "genitore") {
      const [stato, { orari, prova }, dispositivi] = await Promise.all([
        caricaStato(domani), caricaOrari(), caricaDispositivi()
      ]);
      sessione.dispositivi = dispositivi;
      sessione.prova = prova;
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

// Registra il service worker (sw.js): rende l'app installabile e utilizzabile
// offline. Se il browser non lo supporta l'app funziona lo stesso.
function registraServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(e => {
    console.warn("Service worker non registrato:", e);
  });
}

if (typeof document !== "undefined") {
  registraServiceWorker();
  avvia();

  // Quando l'app torna in primo piano (es. dopo il tocco su una notifica)
  // ricarico i dati, così si vede lo stato aggiornato.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && leggiCodice()) avvia();
  });
}
