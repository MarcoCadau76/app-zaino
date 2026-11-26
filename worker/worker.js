// ===== Worker App Zaino — Fase 5: ruoli, serata, orari, notifiche push, cron serale =====
// API (ogni richiesta deve avere l'intestazione X-Codice):
//   GET    /sessione                   -> { ruolo, vapid }  (vapid = chiave pubblica per iscriversi)
//   GET    /stato?data=AAAA-MM-GG      -> { spuntati, chiuso, annullata }
//   POST   /stato?data=AAAA-MM-GG      corpo { spuntati, chiuso }                  (tutti)
//   POST   /serata?data=AAAA-MM-GG     corpo { annullata: bool }                   (solo genitori)
//   GET    /orari                      -> { orari, personalizzati, prova }         (tutti)
//   POST   /orari                      corpo { promemoria, ... }                   (solo genitori)
//   POST   /iscrizione                 corpo { iscrizione, dispositivo }           (tutti)
//   DELETE /iscrizione                 corpo { endpoint }                          (tutti)
//   GET    /iscrizioni                 -> { dispositivi: [...] }                   (solo genitori)
//   POST   /prova                      corpo { destinatari: tutti|francesco|genitore } (solo genitori)
//   POST   /prova-serata?data=...      corpo { attiva: bool }  sequenza compressa  (solo genitori)
// Il ruolo si deduce dal codice: CODICE_GENITORI -> genitore, CODICE_FAMIGLIA -> francesco.
//
// Cron (ogni minuto, vedi wrangler.toml): calcola l'ora italiana e, se è il minuto
// giusto, manda promemoria / solleciti a Francesco e avviso ai genitori.
// Il cron NON scrive mai nel KV: tutto si ricalcola dall'orologio (vedi serata.js).

import { inviaPush, base64UrlInBytes } from "./push.js";
import logica from "../logica.js";
import {
  INIZIO_FINESTRA, FINE_FINESTRA, PIANO_PROVA, DURATA_PROVA_MIN, DESTINATARI,
  oraRoma, domaniDi, pianoDaOrari, eventiSerata, orariProva, riepilogo, messaggioEvento
} from "./serata.js";

const { dataDaTesto, motivoNoScuola, erroreOrari } = logica;

const ORIGINE_PERMESSA = "https://marcocadau76.github.io";
const CONFIG_URL = "https://marcocadau76.github.io/app-zaino/config.json";
const TTL_SERATA = 60 * 60 * 24 * 14;      // i dati di una sera si cancellano dopo 14 giorni
const DURATA_CACHE_CONFIG = 5 * 60 * 1000; // config.json riletto al massimo ogni 5 minuti
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ISCRIZIONI = 20;                 // limite di sicurezza: l'elenco non cresce all'infinito
const CHIAVE_PROVA = "prova_serata";       // { data, inizio } della prova in corso (scade da sola)
const TTL_FRANCESCO = 15 * 60;             // un sollecito vecchio di 15 minuti non serve più
const TTL_GENITORI = 60 * 60;

// Servizi push ammessi: il Worker spedisce solo a questi indirizzi.
const HOST_PUSH = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "notify.windows.com"];

// Copia di config.json tenuta in memoria dall'istanza del Worker.
let configInMemoria = null;
let configLettaAlle = 0;

// ---------- Risposte e CORS ----------

function intestazioniCors() {
  return {
    "Access-Control-Allow-Origin": ORIGINE_PERMESSA,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Codice"
  };
}

function rispostaJson(dati, stato = 200) {
  return new Response(JSON.stringify(dati), {
    status: stato,
    headers: { "Content-Type": "application/json", ...intestazioniCors() }
  });
}

// ---------- Codici e ruoli ----------

// Confronto "a tempo costante": confronto le impronte SHA-256 (stessa lunghezza)
// con timingSafeEqual, così il tempo di risposta non rivela quanti caratteri
// iniziali del codice sono giusti.
async function codiciUguali(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// Restituisce "genitore", "francesco" oppure null se il codice non è valido.
async function ruoloDaCodice(codice, env) {
  if (!codice) return null;
  if (env.CODICE_GENITORI && await codiciUguali(codice, env.CODICE_GENITORI)) return "genitore";
  if (env.CODICE_FAMIGLIA && await codiciUguali(codice, env.CODICE_FAMIGLIA)) return "francesco";
  return null;
}

// ---------- config.json da GitHub Pages (fonte unica dei dati) ----------

async function leggiConfig() {
  const adesso = Date.now();
  if (configInMemoria && adesso - configLettaAlle < DURATA_CACHE_CONFIG) return configInMemoria;
  try {
    const r = await fetch(CONFIG_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error(`config.json: ${r.status}`);
    configInMemoria = await r.json();
    configLettaAlle = adesso;
  } catch (e) {
    // Se GitHub non risponde ma ho una copia vecchia, uso quella.
    if (!configInMemoria) throw e;
  }
  return configInMemoria;
}

// Orari iniziali presi da config.json -> impostazioni.
function orariDaConfig(config) {
  const imp = config.impostazioni || {};
  return {
    promemoria: imp.promemoria || "21:00",
    intervallo_solleciti_min: imp.intervallo_solleciti_min || 10,
    fine_solleciti: imp.fine_solleciti || "22:00",
    avviso_genitori: imp.avviso_genitori || "21:30",
    avvisa_genitori_se_pronto: imp.avvisa_genitori_se_pronto !== false
  };
}

// Orari in uso: quelli salvati dai genitori nel KV, altrimenti quelli di config.json.
// Usata dall'API /orari, dal cron e dall'avviso "Zaino pronto".
async function leggiOrari(env) {
  const salvati = await env.ZAINO.get("orari", "json");
  if (salvati) return { orari: salvati, personalizzati: true };
  return { orari: orariDaConfig(await leggiConfig()), personalizzati: false };
}

// ---------- Validazione dei corpi JSON ----------
// (le regole degli orari, erroreOrari, sono in logica.js: stessa copia della pagina)

function statoValido(corpo) {
  return corpo
    && Array.isArray(corpo.spuntati)
    && corpo.spuntati.every(x => typeof x === "string")
    && typeof corpo.chiuso === "boolean";
}

// true se l'indirizzo è https e appartiene a un servizio push conosciuto.
function endpointValido(testo) {
  try {
    const u = new URL(testo);
    return u.protocol === "https:"
      && HOST_PUSH.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Una chiave base64url che, decodificata, è lunga esattamente `byte`.
function chiaveValida(testo, byte) {
  if (typeof testo !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(testo)) return false;
  try {
    return base64UrlInBytes(testo.replace(/=+$/, "")).length === byte;
  } catch {
    return false;
  }
}

function iscrizioneValida(i) {
  return i
    && endpointValido(i.endpoint)
    && i.keys
    && chiaveValida(i.keys.p256dh, 65)
    && chiaveValida(i.keys.auth, 16);
}

async function leggiCorpo(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- Iscrizioni push nel KV (una sola chiave "iscrizioni") ----------

async function leggiIscrizioni(env) {
  return (await env.ZAINO.get("iscrizioni", "json")) || [];
}

async function scriviIscrizioni(env, lista) {
  await env.ZAINO.put("iscrizioni", JSON.stringify(lista));
}

// Traduce il codice HTTP del servizio push in una frase per i genitori.
function descriviEsito(stato) {
  if (stato >= 200 && stato < 300) return "inviata ✅";
  if (stato === 404 || stato === 410) return "iscrizione scaduta: rimossa";
  if (stato === 0) return "errore di rete";
  return `rifiutata (${stato})`;
}

// Invia un messaggio a tutte le iscrizioni del ruolo indicato
// ("francesco", "genitore", oppure null = tutti). Le iscrizioni scadute
// (404/410) vengono tolte dal KV: è l'unico caso in cui qui si scrive.
// Restituisce il resoconto per dispositivo.
async function inviaNotifica(env, ruolo, messaggio, ttl) {
  const lista = await leggiIscrizioni(env);
  const destinatari = lista.filter(i => !ruolo || i.ruolo === ruolo);

  const esiti = await Promise.all(destinatari.map(async i => {
    try {
      const { stato, dettaglio } = await inviaPush(i, messaggio, env, ttl);
      return { i, stato, dettaglio };
    } catch (e) {
      return { i, stato: 0, dettaglio: String(e).slice(0, 200) };
    }
  }));

  const scadute = new Set(esiti.filter(e => e.stato === 404 || e.stato === 410).map(e => e.i.endpoint));
  if (scadute.size > 0) {
    await scriviIscrizioni(env, lista.filter(i => !scadute.has(i.endpoint)));
  }

  return esiti.map(({ i, stato, dettaglio }) => ({
    dispositivo: i.dispositivo,
    ruolo: i.ruolo,
    stato,
    esito: descriviEsito(stato),
    dettaglio
  }));
}

// ---------- Prova della serata (sequenza compressa) ----------

// Prova in corso letta dal KV, oppure null. { data, inizio (ms) }
async function leggiProva(env) {
  return env.ZAINO.get(CHIAVE_PROVA, "json");
}

// Prova in forma leggibile per la pagina: data + orari "HH:MM" italiani.
function descriviProva(prova) {
  if (!prova) return null;
  return { data: prova.data, ...orariProva(prova.inizio) };
}

// ---------- Sequenza serale: controlli comuni e invio ----------

// Manda gli eventi della serata (promemoria, sollecito, avviso) per la lista di `data`,
// ma solo se domani c'è scuola, la serata non è annullata e lo zaino non è chiuso.
// `prova` = true aggiunge "(prova)" ai titoli. Scrive nel registro (wrangler tail).
async function eseguiEventi(env, eventi, data, prova) {
  const config = await leggiConfig();
  const motivo = motivoNoScuola(dataDaTesto(data), config);
  if (motivo) {
    console.log(`serata ${data}: niente scuola (${motivo}), nessun invio di ${eventi.join("+")}`);
    return;
  }

  const [stato, annullata] = await Promise.all([
    env.ZAINO.get(`stato:${data}`, "json"),
    env.ZAINO.get(`annullata:${data}`)
  ]);
  if (annullata === "1") {
    console.log(`serata ${data}: annullata dai genitori, nessun invio di ${eventi.join("+")}`);
    return;
  }
  if (stato && stato.chiuso) {
    console.log(`serata ${data}: zaino già chiuso, nessun invio di ${eventi.join("+")}`);
    return;
  }

  const conteggio = riepilogo(data, config, stato ? stato.spuntati : []);
  // In sequenza (non in parallelo): se un'iscrizione è scaduta, la seconda
  // spedizione rilegge l'elenco già ripulito invece di sovrascriverlo.
  for (const evento of eventi) {
    const ruolo = DESTINATARI[evento];
    const messaggio = messaggioEvento(evento, data, conteggio, prova);
    const esiti = await inviaNotifica(env, ruolo, messaggio, ruolo === "francesco" ? TTL_FRANCESCO : TTL_GENITORI);
    console.log(`serata ${data}${prova ? " (prova)" : ""}: ${evento} a ${ruolo}, mancano ${conteggio.mancanti}/${conteggio.totale} -> `
      + (esiti.map(e => `${e.dispositivo} ${e.stato}`).join(", ") || "nessun telefono iscritto"));
  }
}

// "Zaino pronto ✅" ai genitori, chiamata quando lo zaino passa da aperto a chiuso.
// Solo se i genitori l'hanno chiesto, se quel giorno c'è scuola e la serata non è annullata.
async function avvisaPronto(env, data) {
  try {
    const [{ orari }, annullata, prova, config] = await Promise.all([
      leggiOrari(env),
      env.ZAINO.get(`annullata:${data}`),
      leggiProva(env),
      leggiConfig()
    ]);
    if (!orari.avvisa_genitori_se_pronto) return;
    if (annullata === "1") return;
    if (motivoNoScuola(dataDaTesto(data), config)) return;

    const inProva = Boolean(prova && prova.data === data);
    const messaggio = messaggioEvento("pronto", data, { mancanti: 0, totale: 0 }, inProva);
    const esiti = await inviaNotifica(env, "genitore", messaggio, TTL_GENITORI);
    console.log(`serata ${data}: pronto ai genitori -> ${esiti.map(e => `${e.dispositivo} ${e.stato}`).join(", ") || "nessun telefono"}`);
  } catch (e) {
    console.log(`avviso "pronto" non riuscito: ${e}`);
  }
}

// Lavoro del cron per il minuto `ms` (ora prevista dello scatto, in UTC).
// Letture: la chiave della prova ogni minuto; gli orari solo tra le 19:00 e le 23:00;
// stato e annullamento solo nei minuti in cui c'è davvero qualcosa da mandare.
async function eseguiCron(env, ms) {
  const adesso = oraRoma(ms);
  const nellaFinestra = adesso.minuti >= INIZIO_FINESTRA && adesso.minuti <= FINE_FINESTRA;

  const [prova, orariInUso] = await Promise.all([
    leggiProva(env),
    nellaFinestra ? leggiOrari(env) : null
  ]);

  // Serata vera: lista di domani (rispetto alla data italiana di oggi).
  if (orariInUso) {
    const eventi = eventiSerata(adesso.minuti, pianoDaOrari(orariInUso.orari));
    if (eventi.length > 0) await eseguiEventi(env, eventi, domaniDi(adesso.data), false);
  }

  // Prova: minuti passati dall'avvio, con il piano compresso.
  if (prova) {
    const minutoProva = Math.round((ms - prova.inizio) / 60000);
    const eventi = eventiSerata(minutoProva, PIANO_PROVA);
    if (eventi.length > 0) await eseguiEventi(env, eventi, prova.data, true);
  }
}

// ---------- Gestori delle singole API ----------

// Stato della lista. Quando lo zaino passa da aperto a chiuso parte (in sottofondo,
// senza far aspettare l'app) l'avviso "Zaino pronto" ai genitori.
async function gestisciStato(request, env, ctx, data) {
  const chiave = `stato:${data}`;

  if (request.method === "GET") {
    // Due letture in parallelo: stato della lista e annullamento della serata.
    const [salvato, annullata] = await Promise.all([
      env.ZAINO.get(chiave, "json"),
      env.ZAINO.get(`annullata:${data}`)
    ]);
    const s = salvato || { spuntati: [], chiuso: false };
    return rispostaJson({ spuntati: s.spuntati, chiuso: s.chiuso, annullata: annullata === "1" });
  }

  if (request.method === "POST") {
    const corpo = await leggiCorpo(request);
    if (!statoValido(corpo)) return rispostaJson({ errore: "stato non valido" }, 400);
    const precedente = await env.ZAINO.get(chiave, "json");
    const stato = { spuntati: corpo.spuntati, chiuso: corpo.chiuso, aggiornato: new Date().toISOString() };
    await env.ZAINO.put(chiave, JSON.stringify(stato), { expirationTtl: TTL_SERATA });
    if (stato.chiuso && !(precedente && precedente.chiuso)) {
      ctx.waitUntil(avvisaPronto(env, data));
    }
    return rispostaJson(stato);
  }

  return rispostaJson({ errore: "metodo non permesso" }, 405);
}

async function gestisciSerata(request, env, data, ruolo) {
  if (request.method !== "POST") return rispostaJson({ errore: "metodo non permesso" }, 405);
  if (ruolo !== "genitore") return rispostaJson({ errore: "solo genitori" }, 403);

  const corpo = await leggiCorpo(request);
  if (!corpo || typeof corpo.annullata !== "boolean") {
    return rispostaJson({ errore: "corpo non valido" }, 400);
  }
  const chiave = `annullata:${data}`;
  if (corpo.annullata) {
    await env.ZAINO.put(chiave, "1", { expirationTtl: TTL_SERATA });
  } else {
    await env.ZAINO.delete(chiave);
  }
  return rispostaJson({ annullata: corpo.annullata });
}

// Orari delle notifiche. La GET restituisce anche l'eventuale prova in corso,
// così la schermata genitore la mostra senza una chiamata in più.
async function gestisciOrari(request, env, ruolo) {
  if (request.method === "GET") {
    const [{ orari, personalizzati }, prova] = await Promise.all([leggiOrari(env), leggiProva(env)]);
    return rispostaJson({ orari, personalizzati, prova: descriviProva(prova) });
  }

  if (request.method === "POST") {
    if (ruolo !== "genitore") return rispostaJson({ errore: "solo genitori" }, 403);
    const corpo = await leggiCorpo(request);
    const errore = erroreOrari(corpo);
    if (errore) return rispostaJson({ errore }, 400); // il messaggio arriva fino alla pagina
    // Salvo solo i campi noti, nient'altro.
    const orari = {
      promemoria: corpo.promemoria,
      intervallo_solleciti_min: corpo.intervallo_solleciti_min,
      fine_solleciti: corpo.fine_solleciti,
      avviso_genitori: corpo.avviso_genitori,
      avvisa_genitori_se_pronto: corpo.avvisa_genitori_se_pronto
    };
    await env.ZAINO.put("orari", JSON.stringify(orari)); // nessuna scadenza
    return rispostaJson({ orari, personalizzati: true });
  }

  return rispostaJson({ errore: "metodo non permesso" }, 405);
}

// Iscrizione di un telefono alle notifiche (POST) o cancellazione (DELETE).
// Il ruolo salvato è quello del codice usato: Francesco non può iscriversi come genitore.
// Si scrive nel KV solo se qualcosa è cambiato: l'app la rimanda a ogni apertura.
async function gestisciIscrizione(request, env, ruolo) {
  const corpo = await leggiCorpo(request);
  const lista = await leggiIscrizioni(env);

  if (request.method === "POST") {
    const i = corpo && corpo.iscrizione;
    if (!iscrizioneValida(i)) return rispostaJson({ errore: "iscrizione non valida" }, 400);
    const dispositivo = typeof corpo.dispositivo === "string" ? corpo.dispositivo.slice(0, 40) : "Telefono";

    const esistente = lista.find(x => x.endpoint === i.endpoint);
    if (esistente
      && esistente.ruolo === ruolo
      && esistente.dispositivo === dispositivo
      && esistente.keys.p256dh === i.keys.p256dh
      && esistente.keys.auth === i.keys.auth) {
      return rispostaJson({ salvata: false }); // già uguale: nessuna scrittura
    }

    const nuova = {
      endpoint: i.endpoint,
      keys: { p256dh: i.keys.p256dh, auth: i.keys.auth },
      ruolo,
      dispositivo,
      creata: esistente ? esistente.creata : new Date().toISOString()
    };
    // Tolgo la vecchia versione, aggiungo la nuova in fondo, tengo le ultime MAX_ISCRIZIONI.
    const aggiornata = [...lista.filter(x => x.endpoint !== i.endpoint), nuova].slice(-MAX_ISCRIZIONI);
    await scriviIscrizioni(env, aggiornata);
    return rispostaJson({ salvata: true });
  }

  if (request.method === "DELETE") {
    const endpoint = corpo && corpo.endpoint;
    const rimasta = lista.filter(x => x.endpoint !== endpoint);
    if (rimasta.length !== lista.length) await scriviIscrizioni(env, rimasta);
    return rispostaJson({ rimossa: rimasta.length !== lista.length });
  }

  return rispostaJson({ errore: "metodo non permesso" }, 405);
}

// Elenco dei telefoni iscritti (senza indirizzi né chiavi), per la schermata genitore.
async function gestisciElencoIscrizioni(request, env, ruolo) {
  if (request.method !== "GET") return rispostaJson({ errore: "metodo non permesso" }, 405);
  if (ruolo !== "genitore") return rispostaJson({ errore: "solo genitori" }, 403);
  const lista = await leggiIscrizioni(env);
  return rispostaJson({
    dispositivi: lista.map(i => ({ dispositivo: i.dispositivo, ruolo: i.ruolo, creata: i.creata }))
  });
}

// Notifica di prova, solo per i genitori.
async function gestisciProva(request, env, ruolo) {
  if (request.method !== "POST") return rispostaJson({ errore: "metodo non permesso" }, 405);
  if (ruolo !== "genitore") return rispostaJson({ errore: "solo genitori" }, 403);
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) {
    return rispostaJson({ errore: "chiavi VAPID non configurate sul Worker" }, 500);
  }

  const corpo = (await leggiCorpo(request)) || {};
  const scelta = ["francesco", "genitore"].includes(corpo.destinatari) ? corpo.destinatari : null;
  const messaggio = {
    titolo: "Zaino · prova",
    testo: "Notifica di prova inviata dai genitori ✅",
    tag: "zaino-prova"
  };
  const esiti = await inviaNotifica(env, scelta, messaggio, 600);
  return rispostaJson({ esiti });
}

// Avvia o ferma la prova della serata per la lista di `data` (solo genitori).
// Una sola scrittura nel KV, con scadenza automatica dopo DURATA_PROVA_MIN minuti.
// La prova parte dal minuto corrente: il promemoria arriva allo scatto successivo.
async function gestisciProvaSerata(request, env, data, ruolo) {
  if (request.method !== "POST") return rispostaJson({ errore: "metodo non permesso" }, 405);
  if (ruolo !== "genitore") return rispostaJson({ errore: "solo genitori" }, 403);
  const corpo = await leggiCorpo(request);
  if (!corpo || typeof corpo.attiva !== "boolean") return rispostaJson({ errore: "corpo non valido" }, 400);

  if (!corpo.attiva) {
    await env.ZAINO.delete(CHIAVE_PROVA);
    return rispostaJson({ prova: null });
  }

  const config = await leggiConfig();
  const motivo = motivoNoScuola(dataDaTesto(data), config);
  if (motivo) {
    return rispostaJson({ errore: `il ${data} non c'è scuola (${motivo}): la prova userebbe una lista vuota e non manderebbe nulla.` }, 400);
  }
  const prova = { data, inizio: Math.floor(Date.now() / 60000) * 60000 };
  await env.ZAINO.put(CHIAVE_PROVA, JSON.stringify(prova), { expirationTtl: DURATA_PROVA_MIN * 60 });
  return rispostaJson({ prova: descriviProva(prova) });
}

// ---------- Punto di ingresso ----------

export default {
  async fetch(request, env, ctx) {
    // Il browser, prima di una richiesta con intestazioni personalizzate,
    // manda una richiesta OPTIONS per chiedere il permesso (CORS).
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: intestazioniCors() });
    }

    const ruolo = await ruoloDaCodice(request.headers.get("X-Codice"), env);
    if (!ruolo) return rispostaJson({ errore: "non autorizzato" }, 401);

    const url = new URL(request.url);
    const data = url.searchParams.get("data") || "";

    try {
      switch (url.pathname) {
        case "/sessione":
          return rispostaJson({ ruolo, vapid: env.VAPID_PUBLIC || null });
        case "/stato":
          if (!RE_DATA.test(data)) return rispostaJson({ errore: "data non valida" }, 400);
          return await gestisciStato(request, env, ctx, data);
        case "/serata":
          if (!RE_DATA.test(data)) return rispostaJson({ errore: "data non valida" }, 400);
          return await gestisciSerata(request, env, data, ruolo);
        case "/orari":
          return await gestisciOrari(request, env, ruolo);
        case "/iscrizione":
          return await gestisciIscrizione(request, env, ruolo);
        case "/iscrizioni":
          return await gestisciElencoIscrizioni(request, env, ruolo);
        case "/prova":
          return await gestisciProva(request, env, ruolo);
        case "/prova-serata":
          if (!RE_DATA.test(data)) return rispostaJson({ errore: "data non valida" }, 400);
          return await gestisciProvaSerata(request, env, data, ruolo);
        default:
          return rispostaJson({ errore: "non trovato" }, 404);
      }
    } catch (e) {
      return rispostaJson({ errore: "errore interno" }, 500);
    }
  },

  // Cron Trigger: Cloudflare lo chiama ogni minuto (orario UTC).
  // scheduledTime = minuto previsto dello scatto: se l'avvio ritarda di qualche
  // secondo, il calcolo resta quello del minuto giusto.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(eseguiCron(env, controller.scheduledTime).catch(e => {
      console.log(`cron non riuscito: ${e && e.stack ? e.stack : e}`);
    }));
  }
};
