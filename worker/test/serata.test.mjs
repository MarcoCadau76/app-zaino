// ===== Test di serata.js: ora italiana, sequenza serale, conteggi, testi =====
// Uso (dalla cartella worker):   node test/serata.test.mjs   (oppure npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  oraRoma, minutiDa, domaniDi, pianoDaOrari, eventiSerata, PIANO_PROVA,
  orariProva, riepilogo, messaggioEvento
} from "../serata.js";
import logica from "../../logica.js";

const config = JSON.parse(readFileSync(new URL("../../config.json", import.meta.url), "utf8"));

// 1. Ora italiana dal tempo UTC, con e senza ora legale.
// Inverno (UTC+1): 20:00 UTC = 21:00 a Roma.
assert.deepEqual(oraRoma(Date.UTC(2026, 10, 26, 20, 0)), { data: "2026-11-26", ora: "21:00", minuti: 1260 });
// Estate (UTC+2): 19:00 UTC = 21:00 a Roma.
assert.deepEqual(oraRoma(Date.UTC(2027, 4, 10, 19, 0)), { data: "2027-05-10", ora: "21:00", minuti: 1260 });
// 23:30 UTC d'inverno = 00:30 del giorno dopo a Roma (la data cambia).
assert.equal(oraRoma(Date.UTC(2026, 11, 31, 23, 30)).data, "2027-01-01");
// Giorno del cambio d'ora (28 marzo 2027): 20:00 UTC = 22:00 a Roma.
assert.equal(oraRoma(Date.UTC(2027, 2, 28, 20, 0)).ora, "22:00");
console.log("ok  ora italiana (ora legale e solare, cambio di data)");

// 2. Domani, anche a fine mese e fine anno.
assert.equal(domaniDi("2026-11-30"), "2026-12-01");
assert.equal(domaniDi("2026-12-31"), "2027-01-01");
assert.equal(minutiDa("21:30"), 1290);
console.log("ok  domani e minuti");

// 3. Sequenza con gli orari di Marco: 21:00, ogni 10, fino 22:00, avviso 21:30.
const piano = pianoDaOrari({
  promemoria: "21:00", intervallo_solleciti_min: 10, fine_solleciti: "22:00",
  avviso_genitori: "21:30", avvisa_genitori_se_pronto: true
});
const sequenza = [];
for (let t = minutiDa("19:00"); t <= minutiDa("23:00"); t++) {
  for (const e of eventiSerata(t, piano)) {
    sequenza.push(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")} ${e}`);
  }
}
assert.deepEqual(sequenza, [
  "21:00 promemoria",
  "21:10 sollecito",
  "21:20 sollecito",
  "21:30 sollecito",
  "21:30 avviso",
  "21:40 sollecito",
  "21:50 sollecito",
  "22:00 sollecito"
]);
console.log("ok  sequenza 21:00-22:00:", sequenza.join(" · "));

// Intervallo che non divide l'ora (7 minuti, fine 21:30): l'ultimo sollecito è alle 21:28.
const piano7 = pianoDaOrari({ promemoria: "21:00", intervallo_solleciti_min: 7, fine_solleciti: "21:30", avviso_genitori: "21:15" });
const solleciti7 = [];
for (let t = 0; t < 1440; t++) if (eventiSerata(t, piano7).includes("sollecito")) solleciti7.push(t - 1260);
assert.deepEqual(solleciti7, [7, 14, 21, 28]);
console.log("ok  intervallo di 7 minuti: solleciti a +7 +14 +21 +28");

// 4. Prova compressa: minuti 1..9 dall'avvio.
const prova = [];
for (let k = -2; k <= 20; k++) for (const e of eventiSerata(k, PIANO_PROVA)) prova.push(`+${k} ${e}`);
assert.deepEqual(prova, ["+1 promemoria", "+3 sollecito", "+4 avviso", "+5 sollecito", "+7 sollecito", "+9 sollecito"]);
const op = orariProva(Date.UTC(2026, 10, 26, 15, 30)); // 16:30 a Roma
assert.deepEqual(op, { promemoria: "16:31", avviso_genitori: "16:34", fine_solleciti: "16:39", intervallo_solleciti_min: 2 });
console.log("ok  prova:", prova.join(" · "));

// 5. Conteggi sulla lista vera: venerdì 27/11 (Inglese, Ed. fisica, Storia, Tecnologia, Geometria).
// Obbligatori: Diario, Astuccio + 2 + 3 + 2 + 2 + 3 = 14.
assert.deepEqual(riepilogo("2026-11-27", config, []), { mancanti: 14, totale: 14 });
assert.deepEqual(riepilogo("2026-11-27", config, ["Ogni giorno|Diario", "Storia|Libro"]), { mancanti: 12, totale: 14 });
// Lunedì: la Tastiera di Musica è facoltativa e non conta.
const lunedi = riepilogo("2026-11-30", config, []);
assert.equal(lunedi.totale, 2 + 2 + 2 + 2 + 1);
console.log("ok  conteggio voci (facoltative escluse)");

// 6. Giorni senza scuola, con le stesse regole della pagina.
const { motivoNoScuola, dataDaTesto, erroreOrari } = logica;
assert.equal(motivoNoScuola(dataDaTesto("2026-11-29"), config), "Domenica");
assert.equal(motivoNoScuola(dataDaTesto("2026-12-08"), config), "Immacolata");
assert.equal(motivoNoScuola(dataDaTesto("2027-01-04"), config), "Vacanze di Natale");
assert.equal(motivoNoScuola(dataDaTesto("2026-11-27"), config), null);
assert.equal(erroreOrari({ promemoria: "21:00", avviso_genitori: "21:30", fine_solleciti: "22:00", intervallo_solleciti_min: 10, avvisa_genitori_se_pronto: true }), null);
console.log("ok  giorni senza scuola e regole orari da logica.js");

// 7. Testi delle notifiche.
const m1 = messaggioEvento("promemoria", "2026-11-27", { mancanti: 14, totale: 14 });
assert.equal(m1.testo, "È ora di preparare lo zaino per venerdì. Mancano 14 voci su 14.");
const m2 = messaggioEvento("sollecito", "2026-11-27", { mancanti: 1, totale: 14 }, true);
assert.equal(m2.titolo, "⏰ Lo zaino non è ancora chiuso (prova)");
assert.equal(m2.testo, "Manca 1 voce su 14.");
const m3 = messaggioEvento("avviso", "2026-11-27", { mancanti: 0, totale: 14 });
assert.match(m3.testo, /spuntato tutto ma non ha chiuso/);
assert.equal(messaggioEvento("pronto", "2026-11-27", { mancanti: 0, totale: 0 }).titolo, "✅ Zaino pronto");
console.log("ok  testi:", m1.titolo, "|", m1.testo);

console.log("\nTutti i test di serata.js superati.");
