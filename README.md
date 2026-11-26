# Zaino

App per preparare lo zaino la sera prima: una checklist con le cose da mettere nello zaino per il giorno dopo,
costruita dall'orario delle lezioni, più notifiche serali per il ragazzo e per i genitori.

**Indirizzo dell'app:** https://marcocadau76.github.io/app-zaino/

## Come funziona la sera

Gli orari si cambiano dalla schermata genitori. Valori iniziali:

| Ora | Cosa succede | A chi |
|---|---|---|
| 21:00 | "Prepara lo zaino" con il numero di voci da mettere | ragazzo |
| ogni 10 min fino alle 22:00 | sollecito, se lo zaino non è ancora chiuso | ragazzo |
| 21:30 | "Zaino non ancora pronto" con le voci mancanti, se non è chiuso | genitori |
| quando preme "Zaino chiuso" | "Zaino pronto ✅" (se l'opzione è attiva); i solleciti si fermano | genitori |

Le notifiche non partono se il giorno dopo non c'è scuola: domenica, vacanze e festività di `config.json`,
giorni fuori dall'anno scolastico. Non partono nemmeno se i genitori hanno premuto **Domani niente scuola**
(si torna indietro con **Ripristina serata**).

## Installazione sui telefoni

Ogni telefono usa uno dei due codici:
- il **codice famiglia** apre la checklist del ragazzo;
- il **codice genitori** apre la schermata genitori.

I codici non sono scritti qui: chiedili a chi gestisce l'app.

### iPhone (iOS 16.4 o successivo)

Le notifiche su iPhone funzionano **solo dall'app aggiunta alla schermata Home**, non da Safari.

1. Apri l'indirizzo dell'app con **Safari**: Chrome su iPhone non permette di installarla con le notifiche.
2. Tocca **Condividi** (il quadrato con la freccia) → **Aggiungi alla schermata Home** → **Aggiungi**.
3. Apri **Zaino** dall'icona sulla Home e inserisci il codice.
   L'app installata non vede i dati di Safari, quindi il codice va inserito di nuovo anche se l'avevi già messo in Safari.
4. Tocca **🔔 Attiva notifiche** → **Consenti**.

Se hai toccato "Non consentire", riattiva le notifiche da **Impostazioni → Notifiche → Zaino → Consenti notifiche**.

### Android con Chrome

1. Apri l'indirizzo dell'app con Chrome.
2. Menu **⋮** → **Installa app** (oppure **Aggiungi a schermata Home**).
3. Apri **Zaino** dall'icona, inserisci il codice, tocca **🔔 Attiva notifiche** → **Consenti**.

Se la richiesta non compare, apri **Chrome → ⋮ → Impostazioni → Impostazioni sito → Notifiche**.
Disattiva "Usa messaggi più discreti" e imposta `marcocadau76.github.io` su **Consenti**.

### Android con Samsung Internet

Nell'app installata da Samsung Internet la richiesta del permesso può **non comparire affatto**:
il tasto resta in attesa e dopo 30 secondi l'app mostra un messaggio. Per questo l'ordine è diverso:

1. Apri l'indirizzo dell'app in una **scheda normale** di Samsung Internet e inserisci il codice.
2. Tocca **🔔 Attiva notifiche** → **Consenti**. Il permesso vale per il sito, quindi anche per l'app che installi dopo.
3. Menu **≡** → **Aggiungi pagina a** → **Schermata Home**.
4. Apri **Zaino** dall'icona: le notifiche risultano già attive. Se l'app lo chiede, reinserisci il codice.

Se l'app era già installata e il permesso non era stato dato, fai così:
1. Togli l'icona dalla Home.
2. Apri l'indirizzo in una scheda di Samsung Internet. Se si apre l'app installata invece della scheda,
   rimuovi prima l'app dalle impostazioni di Android.
3. Rifai i passi da 1 a 4 qui sopra.

### Verifica finale

Dal telefono di un genitore, nella sezione **Notifiche**:

1. Controlla l'elenco dei telefoni iscritti: ci deve essere ogni telefono, con il ruolo giusto.
2. **Invia notifica di prova** a "tutti": ogni telefono deve risultare "inviata ✅" e la notifica deve arrivare.
3. **Prova la sequenza (10 minuti)** fa la serata vera in piccolo, con la lista vera di domani:
   - minuto 1: promemoria;
   - minuti 3, 5, 7 e 9: solleciti;
   - minuto 4: avviso ai genitori.

   Se lo zaino di domani è già chiuso non arriva nulla, come la sera vera: prima premi **Riapri**.

## Problemi frequenti

| Problema | Soluzione |
|---|---|
| Un telefono non riceve più nulla | Apri l'app su quel telefono: rinnova da sola l'iscrizione. Se compare di nuovo **Attiva notifiche**, toccalo. |
| Un telefono compare due volte nell'elenco | Capita dopo una reinstallazione. L'iscrizione vecchia viene tolta da sola al primo invio che il servizio push rifiuta. |
| "Codice errato" | Il codice è stato cambiato: inserisci quello nuovo. |
| L'app mostra una versione vecchia | Chiudila e riaprila due volte: la prima apertura scarica la versione nuova, la seconda la mostra. |
| Arriva un sollecito subito dopo aver chiuso lo zaino | Normale se succede entro un minuto dalla chiusura: il server può impiegare fino a un minuto a vedere ovunque lo stato nuovo. |

---

## Per chi lo gestisce

### Struttura

| File | Cosa contiene |
|---|---|
| `index.html`, `app.js` | La pagina (GitHub Pages, nessun framework, nessun build) |
| `logica.js` | Funzioni pure condivise da pagina e Worker: date, giorni senza scuola, lista, conteggi, regole degli orari |
| `config.json` | Anno scolastico, chiusure, oggetti di ogni materia, orario settimanale, orari iniziali delle notifiche |
| `sw.js`, `manifest.webmanifest`, `icons/` | App installabile, funzionamento offline, ricezione delle notifiche |
| `worker/worker.js` | API su Cloudflare Workers: stato della lista, ruoli, orari, iscrizioni, cron serale |
| `worker/serata.js` | Calcoli del cron: ora italiana, quali notifiche mandare a quale minuto, testi |
| `worker/push.js` | Web Push cifrato (RFC 8291) e firma VAPID (RFC 8292) con WebCrypto, senza librerie |

### Ogni anno scolastico

Aggiorna `config.json` con `anno_scolastico`, `chiusure` (il calendario regionale), `orario` e `materie`, poi fai il push su `main`.
Il Worker rilegge `config.json` da GitHub Pages entro 5 minuti: non serve ripubblicarlo.

Le date sono nel formato `AAAA-MM-GG`. Un oggetto facoltativo si scrive `{ "nome": "Tastiera", "facoltativo": true }`
e non conta per completare la lista.

Se cambi l'elenco dei file dell'app (`FILE_APP` in `sw.js`), aumenta anche `NOME_CACHE` (`zaino-v2` → `zaino-v3`).

### Worker (dalla cartella `worker/`)

```powershell
npm install                # la prima volta
npm test                   # test di cifratura push e della sequenza serale
npx wrangler deploy        # pubblica il Worker e il cron
npx wrangler tail          # registro in diretta: ogni invio del cron con l'esito per telefono
```

I segreti si impostano solo con `npx wrangler secret put NOME` e non vanno mai nel repository:

| Segreto | Cosa è |
|---|---|
| `CODICE_FAMIGLIA` | codice del ragazzo |
| `CODICE_GENITORI` | codice dei genitori |
| `VAPID_PRIVATE` | chiave privata per le notifiche |

Le chiavi VAPID si generano una volta sola con `node strumenti/genera-vapid.mjs`.
La pubblica va in `wrangler.toml`. Se le rigeneri, ogni telefono deve riattivare le notifiche.

Per provare in locale, `npx wrangler dev` usa i valori di prova in `worker/.dev.vars`, file escluso da git.

### Scelte di progetto

- **Cron ogni minuto senza scritture.** Ogni minuto il Worker calcola l'ora italiana (`Europe/Rome`, ora legale compresa)
  e ricava dall'orologio se è il minuto del promemoria, di un sollecito o dell'avviso. Così non deve salvare
  cosa ha già mandato e resta nei limiti gratuiti di Cloudflare KV (1.000 scritture al giorno): il cron legge e basta.
- **Scritture nel KV solo quando cambia qualcosa:** una spunta, la chiusura dello zaino, gli orari, una serata annullata,
  un telefono nuovo, l'avvio di una prova. I dati di ogni sera scadono da soli dopo 14 giorni.
- **Ruoli decisi dal server:** il Worker riconosce il ruolo dal codice e rifiuta (403) le funzioni da genitore
  chieste con il codice famiglia.

### Test con un'altra data

Aggiungi `?oggi=AAAA-MM-GG` all'indirizzo per far finta che oggi sia un altro giorno.
Per esempio `?oggi=2026-12-22` mostra la lista di mercoledì 23 dicembre, che è vacanza.
