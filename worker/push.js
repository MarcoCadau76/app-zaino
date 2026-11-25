// ===== push.js — invio di notifiche Web Push con WebCrypto (nessuna libreria) =====
// Due standard:
//   - RFC 8291: cifratura del messaggio (solo il telefono può leggerlo);
//   - RFC 8292 (VAPID): firma che dimostra ad Apple/Google che il messaggio viene da noi.
// Le funzioni sono esportate anche per i test in Node (worker/test/push.test.mjs).

const enc = new TextEncoder();

// ---------- Conversioni base64url <-> byte ----------

export function base64UrlInBytes(testo) {
  const b64 = testo.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((testo.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function bytesInBase64Url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Unisce più array di byte in uno solo.
function concatena(...parti) {
  const totale = parti.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(totale);
  let pos = 0;
  for (const p of parti) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// HKDF-SHA-256: da un segreto ricava una chiave della lunghezza voluta (in byte).
async function hkdf(sale, materiale, info, lunghezza) {
  const chiave = await crypto.subtle.importKey("raw", materiale, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: sale, info },
    chiave,
    lunghezza * 8
  );
  return new Uint8Array(bits);
}

// ---------- Cifratura del messaggio (RFC 8291, "aes128gcm") ----------
// p256dh e auth arrivano dall'iscrizione del telefono (base64url).
// Restituisce il corpo binario da spedire al servizio push.
export async function cifraMessaggio(testo, p256dh, auth) {
  const pubblicaTelefono = base64UrlInBytes(p256dh); // 65 byte
  const segretoAuth = base64UrlInBytes(auth);         // 16 byte

  // 1. Coppia di chiavi usa-e-getta del server, solo per questo messaggio.
  const coppia = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pubblicaServer = new Uint8Array(await crypto.subtle.exportKey("raw", coppia.publicKey));

  // 2. Segreto condiviso ECDH tra la nostra chiave usa-e-getta e quella del telefono.
  const chiaveTelefono = await crypto.subtle.importKey(
    "raw", pubblicaTelefono, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const segretoEcdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: chiaveTelefono }, coppia.privateKey, 256
  ));

  // 3. Mescolo il segreto ECDH con il segreto "auth" del telefono.
  const infoChiave = concatena(enc.encode("WebPush: info\0"), pubblicaTelefono, pubblicaServer);
  const ikm = await hkdf(segretoAuth, segretoEcdh, infoChiave, 32);

  // 4. Sale casuale -> chiave AES (16 byte) e nonce (12 byte).
  const sale = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sale, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(sale, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // 5. Cifro: testo + byte 0x02 ("ultimo blocco", nessun riempimento).
  const chiaveAes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const inChiaro = concatena(enc.encode(testo), new Uint8Array([2]));
  const cifrato = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, chiaveAes, inChiaro));

  // 6. Intestazione: sale (16) | dimensione blocco (4, = 4096) | lunghezza id (1, = 65) | chiave server (65).
  const intestazione = new Uint8Array(16 + 4 + 1 + 65);
  intestazione.set(sale, 0);
  new DataView(intestazione.buffer).setUint32(16, 4096);
  intestazione[20] = 65;
  intestazione.set(pubblicaServer, 21);
  return concatena(intestazione, cifrato);
}

// ---------- Firma VAPID (RFC 8292) ----------
// JWT firmato con la chiave privata VAPID: valido 1 ora, riusato finché
// mancano più di 10 minuti alla scadenza (risparmia calcoli).
const jwtInMemoria = new Map(); // origine del servizio push -> { jwt, scade }

export async function intestazioneVapid(endpoint, pubblica, privata, soggetto) {
  const aud = new URL(endpoint).origin;
  const adesso = Math.floor(Date.now() / 1000);
  const salvato = jwtInMemoria.get(aud);
  if (salvato && salvato.scade - adesso > 600) return `vapid t=${salvato.jwt}, k=${pubblica}`;

  const scade = adesso + 3600;
  const testa = bytesInBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = bytesInBase64Url(enc.encode(JSON.stringify({ aud, exp: scade, sub: soggetto })));

  // La chiave privata è salvata come solo "d"; x e y vengono dalla pubblica (65 byte: 0x04|x|y).
  const pub = base64UrlInBytes(pubblica);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesInBase64Url(pub.slice(1, 33)),
    y: bytesInBase64Url(pub.slice(33, 65)),
    d: privata,
    ext: true
  };
  const chiave = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chiave, enc.encode(`${testa}.${corpo}`));

  const jwt = `${testa}.${corpo}.${bytesInBase64Url(firma)}`;
  jwtInMemoria.set(aud, { jwt, scade });
  return `vapid t=${jwt}, k=${pubblica}`;
}

// ---------- Invio ----------
// iscrizione: { endpoint, keys: { p256dh, auth } }; messaggio: oggetto JSON.
// ttl: per quanti secondi il servizio push deve tentare la consegna se il telefono è spento.
// Restituisce { stato, dettaglio } (stato = codice HTTP del servizio push).
export async function inviaPush(iscrizione, messaggio, env, ttl = 3600) {
  const corpo = await cifraMessaggio(JSON.stringify(messaggio), iscrizione.keys.p256dh, iscrizione.keys.auth);
  const autorizzazione = await intestazioneVapid(
    iscrizione.endpoint, env.VAPID_PUBLIC, env.VAPID_PRIVATE, env.VAPID_SUBJECT
  );
  const risposta = await fetch(iscrizione.endpoint, {
    method: "POST",
    headers: {
      "Authorization": autorizzazione,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttl),
      "Urgency": "high"
    },
    body: corpo
  });
  const dettaglio = risposta.ok ? "" : (await risposta.text()).slice(0, 200);
  return { stato: risposta.status, dettaglio };
}
