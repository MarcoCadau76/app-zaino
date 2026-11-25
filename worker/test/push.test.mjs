// ===== Test di push.js: cifratura e firma VAPID verificate da strumenti indipendenti =====
// Uso (dalla cartella worker):   node test/push.test.mjs
// - la cifratura viene DECIFRATA con http_ece (la libreria usata da "web-push");
// - la firma del JWT VAPID viene verificata con il modulo crypto di Node.
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import ece from "http_ece";
import { cifraMessaggio, intestazioneVapid, bytesInBase64Url, base64UrlInBytes } from "../push.js";

// 1. Simulo un telefono: chiave ECDH P-256 e segreto "auth" da 16 byte.
const telefono = nodeCrypto.createECDH("prime256v1");
telefono.generateKeys();
const auth = nodeCrypto.randomBytes(16);
const p256dh = bytesInBase64Url(telefono.getPublicKey());

// 2. Cifro con il nostro codice e decifro con http_ece, come farebbe il telefono.
const messaggio = JSON.stringify({ titolo: "Zaino", testo: "Prepara lo zaino per domani 🎒 àèìòù" });
const cifrato = await cifraMessaggio(messaggio, p256dh, bytesInBase64Url(auth));
const decifrato = ece.decrypt(Buffer.from(cifrato), {
  version: "aes128gcm",
  privateKey: telefono,
  authSecret: auth
});
assert.equal(decifrato.toString("utf8"), messaggio);
console.log("ok  cifratura aes128gcm decifrata da http_ece");

// Due cifrature dello stesso testo devono essere diverse (sale e chiave usa-e-getta nuovi).
const altro = await cifraMessaggio(messaggio, p256dh, bytesInBase64Url(auth));
assert.notDeepEqual(Buffer.from(altro), Buffer.from(cifrato));
console.log("ok  ogni messaggio ha sale e chiave diversi");

// 3. Firma VAPID: genero chiavi di prova e verifico il JWT con Node.
const vapid = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwkPriv = vapid.privateKey.export({ format: "jwk" });
const pubRaw = Buffer.concat([Buffer.from([4]), base64UrlInBytes(jwkPriv.x), base64UrlInBytes(jwkPriv.y)]);
const pubB64 = bytesInBase64Url(pubRaw);

const endpoint = "https://web.push.apple.com/QAbc123";
const intestazione = await intestazioneVapid(endpoint, pubB64, jwkPriv.d, "https://marcocadau76.github.io/app-zaino/");
const [, jwt, k] = intestazione.match(/^vapid t=([^,]+), k=(.+)$/);
assert.equal(k, pubB64);
const [testa, corpo, firma] = jwt.split(".");
const valida = nodeCrypto.verify("sha256", Buffer.from(`${testa}.${corpo}`),
  { key: vapid.publicKey, dsaEncoding: "ieee-p1363" }, base64UrlInBytes(firma));
assert.ok(valida, "firma VAPID non valida");
const dati = JSON.parse(Buffer.from(base64UrlInBytes(corpo)).toString());
assert.equal(dati.aud, "https://web.push.apple.com");
assert.ok(dati.exp > Date.now() / 1000 && dati.exp <= Date.now() / 1000 + 3600);
console.log("ok  JWT VAPID firmato correttamente, aud =", dati.aud);

console.log("\nTutti i test superati.");
