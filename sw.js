// ===== Service worker App Zaino — Fasi 3-5: app installabile, offline, notifiche push =====
// Strategia "prima la rete": se c'è connessione scarico sempre la versione nuova
// (così ogni aggiornamento su GitHub arriva subito) e ne tengo una copia;
// la copia in cache si usa SOLO quando la rete non risponde.
// Le chiamate al Worker (altro dominio) non passano di qui: lo stato è sempre quello vero.
// Fase 4: riceve le notifiche push (testo già dentro, cifrato) e le mostra.

// Cambia il numero quando cambi l'elenco dei file: la cache vecchia viene cancellata.
const NOME_CACHE = "zaino-v2";

const FILE_APP = [
  "./",
  "index.html",
  "logica.js",
  "app.js",
  "config.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

// Installazione: metto da parte i file dell'app, poi attivo subito la nuova
// versione senza aspettare che tutte le schede vecchie vengano chiuse.
self.addEventListener("install", evento => {
  evento.waitUntil(
    caches.open(NOME_CACHE)
      .then(cache => cache.addAll(FILE_APP))
      .then(() => self.skipWaiting())
  );
});

// Attivazione: cancello le cache delle versioni precedenti e prendo
// il controllo delle pagine già aperte.
self.addEventListener("activate", evento => {
  evento.waitUntil(
    caches.keys()
      .then(nomi => Promise.all(nomi.filter(n => n !== NOME_CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Richieste: solo GET dello stesso sito (GitHub Pages); tutto il resto passa diretto.
self.addEventListener("fetch", evento => {
  const richiesta = evento.request;
  if (richiesta.method !== "GET") return;
  if (new URL(richiesta.url).origin !== self.location.origin) return;
  evento.respondWith(primaLaRete(richiesta));
});

async function primaLaRete(richiesta) {
  const cache = await caches.open(NOME_CACHE);
  try {
    // cache: "no-cache" = chiedo comunque al server se il file è cambiato,
    // invece di fidarmi della cache del browser (GitHub la tiene 10 minuti).
    const risposta = await fetch(richiesta.url, { cache: "no-cache" });
    if (risposta.ok) {
      // Salvo senza i parametri (?oggi=...), così la copia offline vale per tutti.
      const url = new URL(richiesta.url);
      url.search = "";
      await cache.put(url.href, risposta.clone());
    }
    return risposta;
  } catch {
    // Offline: uso la copia salvata (ignorando i parametri come ?oggi=...).
    const copia = await cache.match(richiesta, { ignoreSearch: true });
    if (copia) return copia;
    // Pagina aperta offline e mai salvata con questo indirizzo: mostro index.html.
    if (richiesta.mode === "navigate") {
      const pagina = await cache.match("index.html");
      if (pagina) return pagina;
    }
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

// ---------- Notifiche push (Fase 4) ----------

// Arriva una push: il browser l'ha già decifrata, il contenuto è JSON
// { titolo, testo, tag }. iOS esige che OGNI push mostri una notifica,
// quindi se il contenuto manca o è rovinato ne mostro comunque una generica.
self.addEventListener("push", evento => {
  let dati = {};
  try {
    dati = evento.data ? evento.data.json() : {};
  } catch {
    dati = {};
  }
  const titolo = dati.titolo || "Zaino";
  const opzioni = {
    body: dati.testo || "Apri l'app per vedere lo zaino di domani.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    // Stesso tag = la notifica nuova sostituisce la vecchia (niente pila di solleciti).
    tag: dati.tag || "zaino",
    renotify: true,
    data: { url: "./" }
  };
  evento.waitUntil(self.registration.showNotification(titolo, opzioni));
});

// Tocco sulla notifica: porto in primo piano l'app se è già aperta,
// altrimenti la apro.
self.addEventListener("notificationclick", evento => {
  evento.notification.close();
  evento.waitUntil((async () => {
    const finestre = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const finestra of finestre) {
      if ("focus" in finestra) return finestra.focus();
    }
    return self.clients.openWindow(evento.notification.data?.url || "./");
  })());
});
