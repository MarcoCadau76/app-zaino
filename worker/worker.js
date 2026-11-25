// ===== Worker App Zaino — passo 2: stato condiviso =====
// API:
//   GET  /stato?data=AAAA-MM-GG  -> { spuntati: [...], chiuso: bool }
//   POST /stato?data=AAAA-MM-GG  (corpo JSON come sopra) -> salva
// Ogni richiesta deve avere l'intestazione X-Codice uguale al segreto CODICE.

const ORIGINE_PERMESSA = "https://marcocadau76.github.io";

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

function statoValido(corpo) {
  return corpo
    && Array.isArray(corpo.spuntati)
    && corpo.spuntati.every(x => typeof x === "string")
    && typeof corpo.chiuso === "boolean";
}

export default {
  async fetch(request, env) {
    // Il browser, prima di una richiesta con intestazioni personalizzate,
    // manda una richiesta OPTIONS per chiedere il permesso (CORS).
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: intestazioniCors() });
    }

    if (request.headers.get("X-Codice") !== env.CODICE) {
      return rispostaJson({ errore: "non autorizzato" }, 401);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/stato") {
      return rispostaJson({ errore: "non trovato" }, 404);
    }

    const data = url.searchParams.get("data") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return rispostaJson({ errore: "data non valida" }, 400);
    }
    const chiave = `stato:${data}`;

    if (request.method === "GET") {
      const salvato = await env.ZAINO.get(chiave, "json");
      return rispostaJson(salvato || { spuntati: [], chiuso: false });
    }

    if (request.method === "POST") {
      let corpo;
      try {
        corpo = await request.json();
      } catch {
        return rispostaJson({ errore: "JSON non valido" }, 400);
      }
      if (!statoValido(corpo)) {
        return rispostaJson({ errore: "stato non valido" }, 400);
      }
      const stato = {
        spuntati: corpo.spuntati,
        chiuso: corpo.chiuso,
        aggiornato: new Date().toISOString()
      };
      // Dopo 14 giorni lo stato di una sera si cancella da solo.
      await env.ZAINO.put(chiave, JSON.stringify(stato), { expirationTtl: 60 * 60 * 24 * 14 });
      return rispostaJson(stato);
    }

    return rispostaJson({ errore: "metodo non permesso" }, 405);
  }
};
