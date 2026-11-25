// ===== Service worker App Zaino — Fase 3: app installabile e funzionante offline =====
// Strategia "prima la rete": se c'è connessione scarico sempre la versione nuova
// (così ogni aggiornamento su GitHub arriva subito) e ne tengo una copia;
// la copia in cache si usa SOLO quando la rete non risponde.
// Le chiamate al Worker (altro dominio) non passano di qui: lo stato è sempre quello vero.
// In Fase 4 qui arriverà anche la gestione delle notifiche push.

// Cambia il numero quando cambi l'elenco dei file: la cache vecchia viene cancellata.
const NOME_CACHE = "zaino-v1";

const FILE_APP = [
  "./",
  "index.html",
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
