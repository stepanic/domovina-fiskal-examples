# Google Forms → Sheets → Domovina Fiskal: postavljanje eventa

Postupak za jedan event (konferencija, seminar, kotizacije). Uvijek najprije
**DEV kopija Sheeta + Fiskal TEST**, a tek kad sve radi pravi Sheet + Fiskal PROD.

## Kako radi

1. Sudionik ispuni Google Formu → novi redak u Sheetu.
2. Organizator vidi uplatu na računu i upiše iznos u stupac **„Uplata”**.
3. Klik na checkbox u stupcu `AKCIJA_RACUN` (ili izbornik → Bulk) →
   `POST /racun` → u retku se pojave status, broj računa, JIR i link na račun.

Isti bundle ide na TEST i PROD. Okolinu skripta bira **po ID-u Sheeta**
(`okoline.json`), pa DEV kopija ne može izdati PROD račun ni obrnuto. Nepoznat
Sheet (npr. nova kopija) skripta odbija dok ga ne upišeš i ne napraviš push.

## 0. Preduvjeti

- Node.js ≥ 22.18 i [`clasp`](https://github.com/google/clasp) (`npm i -g @google/clasp`, `clasp login`).
- Tenant u Domovina Fiskalu s API ključem za TEST (i kasnije za PROD).
- Google Forma povezana sa Sheetom i **DEV kopija** tog Sheeta (File → Make a copy).
  Ako originalni Sheet već ima bound Apps Script, kopija ga kopira: provjeri
  Extensions → Apps Script u kopiji.
- Google račun s kojim je `clasp` logiran mora biti **Editor** na oba Sheeta.

## 1. Config

```bash
cp -r gas/events/primjer-konferencija-2027 gas/events/<moj-event>
```

- `Config.gs`: naziv usluge, datum, uvjeti, prefiks reference, `FISKAL` blok
  (prostor, uređaj, operater iz `GET /postavke`) i **točni headeri** stupaca.
  Headeri moraju biti doslovno isti kao u Sheetu. Google Forms zna ostaviti
  razmak ili `\n` na kraju headera; najlakše ih je dobiti iz konzole preglednika
  na otvorenom Sheetu:
  ```js
  const t = await (await fetch('/spreadsheets/d/<sheetId>/export?format=tsv&gid=<gid>')).text();
  JSON.stringify(t.split('\n')[0].split('\t'))
  ```
- `okoline.json`: `sheetId` DEV i PROD Sheeta. Za `npm run postavke` upiši i
  putanju do datoteke s ključem (`secrets/` je u `.gitignore`).

```bash
npm test                         # parser države, payload, idempotencija, oporavak
npm run postavke -- <moj-event> test   # read-only GET /postavke
npm run build -- <moj-event>
```

## 2. Bound Apps Script projekt (po okolini)

```bash
mkdir -p /tmp/clasp-create && cd /tmp/clasp-create
clasp create --title "<Naziv> (TEST)" --parentId <sheetId>   # BEZ --type sheets!
cat .clasp.json   # scriptId → okoline.json → okoline.test.scriptId
```

S `--type sheets` clasp ignorira `--parentId` i napravi novi prazni Sheet.

## 3. Push

```bash
npm run push -- <moj-event> test
npm run push -- <moj-event> prod --da-prod
```

## 4. Organizator jednom u Sheetu (izbornik „🧾 Fiskal računi”)

1. 🔐 Autoriziraj dozvole
2. ⚙️ Postavi API ključ: samo ključ (sprema se u Script Properties); okolinu
   skripta zna po ID-u Sheeta i ključ odmah provjeri s `GET /postavke`
3. 🔧 Instaliraj onEdit trigger (clasp ne može postaviti triggere)
4. 📋 Dodaj stupce (OIB, Payment Type, `AKCIJA_RACUN`); stupce `Fiskal *`
   skripta dodaje sama kod prvog računa

**E-mail kupcu** (`AUTO_EMAIL: true`): odmah nakon izdavanja, ako račun ima JIR.
Ako račun čeka JIR, stupac „Fiskal E-mail” je žut („čeka JIR — mail ide nakon
fiskalizacije”) i nije greška: 🔄 Osvježi status pošalje mail čim račun dobije
JIR, i to točno jednom, jer Fiskal pamti `poslanoEmail`. Ručno ✉️ slanje računa
bez JIR-a pita smije li ići samo sa ZKI-jem (`bezJir: true`).

Ostalo u izborniku: Bulk (svi redci s Uplatom bez računa, u serijama od 4,5
min zbog GAS limita), ✉️ Pošalji e-mailom, 🔄 Osvježi status (čeka JIR),
↩️ Storno 100 % / 50 %.

## 5. Provjera na TEST okolini (DEV Sheet)

- Redak s Uplata = 100 → checkbox → JIR u statusu.
- Ponovni klik na isti redak → **isti** broj računa (idempotent replay).
- Redak bez Uplate → validacijska greška, ništa se ne izdaje.
- Kupci iz više država → ispravan `kupac.adresa.drzava` na PDF-u.
- Bulk nad svim redcima; prekid i ponovno pokretanje nastavlja bez duplikata.
- Djelomični storno (50 %) jednog računa.

## 6. PROD

Na PROD-u nema probnih računa: **svaki fiskalni račun ide u CIS**. Prvi PROD
račun neka bude pravi sudionik s pravom uplatom.
