// ===== Genera la coppia di chiavi VAPID (da eseguire UNA volta sola) =====
// Uso (dalla cartella worker):   node strumenti/genera-vapid.mjs
// - la PUBBLICA va in wrangler.toml (VAPID_PUBLIC): non è segreta;
// - la PRIVATA va SOLO in:        npx wrangler secret put VAPID_PRIVATE
//   e non va salvata nel repository né in altri file.
// Se rigeneri le chiavi, tutti i telefoni devono riattivare le notifiche.

function inBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
);
const pubblica = inBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
const privata = (await crypto.subtle.exportKey("jwk", privateKey)).d; // già in base64url

console.log("\nCHIAVE PUBBLICA (mandala a Claude / mettila in wrangler.toml):");
console.log(pubblica);
console.log("\nCHIAVE PRIVATA (incollala solo in 'npx wrangler secret put VAPID_PRIVATE'):");
console.log(privata);
console.log("");
