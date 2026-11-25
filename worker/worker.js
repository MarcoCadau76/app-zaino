// ===== Worker App Zaino — Fase 2: ruoli, annulla serata, orari =====
// API (ogni richiesta deve avere l'intestazione X-Codice):
//   GET  /sessione                      -> { ruolo: "francesco" | "genitore" }
//   GET  /stato?data=AAAA-MM-GG         -> { spuntati, chiuso, annullata }
//   POST /stato?data=AAAA-MM-GG         corpo { spuntati, chiuso }        (tutti)
//   POST /serata?data=AAAA-MM-GG        corpo { annullata: bool }         (solo genitori)
//   GET  /orari                         -> { orari, personalizzati }      (tutti)
//   POST /orari                         corpo { promemoria, ... }         (solo genitori)
// Il ruolo si deduce dal codice: CODICE_GENITORI -> genitore, CODICE_FAMIGLIA -> francesco.

const ORIGINE_PERMESSA = "https://marcocadau76.github.io";
const CONFIG_URL = "https://marcocadau76.github.io/app-zaino/config.json";
const TTL_SERATA = 60 * 60 * 24 * 14;      // i dati di una sera si cancellano dopo 14 giorni
const DURATA_CACHE_CONFIG = 5 * 60 * 1000; // config.json riletto al massimo ogni 5 minuti
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

// Copia di config.json tenuta in memoria dall'istanza del Worker.
let configInMemoria = null;
let configLettaAlle = 0;

// ---------- Risposte e CORS ----------

function intestazioniCors() {
  return {
    "Access-Control-Allow-Origin": ORIGINE_PERMESSA,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ---------- Validazione dei corpi JSON ----------

function statoValido(corpo) {
  return corpo
    && Array.isArray(corpo.spuntati)
    && corpo.spuntati.every(x => typeof x === "string")
    && typeof corpo.chiuso === "boolean";
}

// Controlla gli orari e restituisce null se vanno bene, altrimenti il messaggio
// della PRIMA regola non rispettata. Regole:
//   - tutti gli orari tra le 19:00 e le 23:00 (estremi compresi);
//   - promemoria < avviso genitori <= fine solleciti;
//   - intervallo solleciti: intero tra 5 e 30 minuti.
// Le ore "HH:MM" si confrontano bene anche come stringhe ("21:00" < "22:00").
// ATTENZIONE: copia identica in app.js (erroreOrari): se cambi una, cambia l'altra.
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

async function leggiCorpo(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- Gestori delle singole API ----------

async function gestisciStato(request, env, data) {
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
    const stato = { spuntati: corpo.spuntati, chiuso: corpo.chiuso, aggiornato: new Date().toISOString() };
    await env.ZAINO.put(chiave, JSON.stringify(stato), { expirationTtl: TTL_SERATA });
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

async function gestisciOrari(request, env, ruolo) {
  if (request.method === "GET") {
    const salvati = await env.ZAINO.get("orari", "json");
    if (salvati) return rispostaJson({ orari: salvati, personalizzati: true });
    const config = await leggiConfig();
    return rispostaJson({ orari: orariDaConfig(config), personalizzati: false });
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

// ---------- Punto di ingresso ----------

export default {
  async fetch(request, env) {
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
          return rispostaJson({ ruolo });
        case "/stato":
          if (!RE_DATA.test(data)) return rispostaJson({ errore: "data non valida" }, 400);
          return await gestisciStato(request, env, data);
        case "/serata":
          if (!RE_DATA.test(data)) return rispostaJson({ errore: "data non valida" }, 400);
          return await gestisciSerata(request, env, data, ruolo);
        case "/orari":
          return await gestisciOrari(request, env, ruolo);
        default:
          return rispostaJson({ errore: "non trovato" }, 404);
      }
    } catch (e) {
      return rispostaJson({ errore: "errore interno" }, 500);
    }
  }
};
