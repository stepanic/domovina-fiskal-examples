# Domovina Fiskal API: što klijent mora znati

Sažetak javnog API-ja `v1` za integracije. Izvor istine je kod u
[`domovinatv/domovina-fiskal`](https://github.com/domovinatv/domovina-fiskal)
(`backend/src/validacija.ts`, `backend/src/api/racuni.ts`); `GET /` na
serveru (npr. `https://fiskal-test.domovina.ai/`) vraća kratki pregled ruta.

## Okoline

| Okolina | Base URL | CIS |
|---|---|---|
| TEST | `https://fiskal-test.domovina.ai/api/v1` | CIS TEST okolina, demo certifikat: računi nisu stvarni |
| PROD | `https://fiskal.domovina.ai/api/v1` | pravi CIS: **svaki fiskalni račun je stvaran** |

Ključ je po tenantu (izdavatelju): `Authorization: Bearer dfk_<64 hex>`. Dobiva se
od administratora Fiskala. Drži ga u secretima (Script Properties, `wrangler
secret`, env), nikad u kodu ni u gitu. TEST i PROD imaju **različite** ključeve.

Tvoje oznake poslovnog prostora, naplatnog uređaja i operatera (i jesi li u
sustavu PDV-a) vraća `GET /postavke`:

```bash
curl -s -H "Authorization: Bearer $FISKAL_API_KEY" https://fiskal-test.domovina.ai/api/v1/postavke
```

## Izdavanje: `POST /racun`

```jsonc
{
  "tip": "FISKALNI_B2C",            // PONUDA | PREDRACUN | RACUN | FISKALNI_B2C | ERACUN_B2B | ERACUN_B2G
  "poslovniProstor": "1",           // iz GET /postavke
  "naplatniUredaj": "1",
  "operaterOib": "12345678903",     // obavezan za FISKALNI_B2C (CIS OibOper)
  "nacinPlacanja": "KARTICA",       // GOTOVINA | KARTICA | TRANSAKCIJSKI | OSTALO
  "valuta": "EUR",
  "datumIsporuke": "2027-03-12",    // YYYY-MM-DD; datum izdavanja postavlja server
  "uvjeti": "…",                    // ≤4000 znakova, na PDF-u
  "napomena": "…",                  // ≤2000, na PDF-u kao „Napomena:”
  "internaBiljeska": "…",           // ≤2000, NIJE na PDF-u
  "vanjskaReferenca": "narudzba-1042", // ≤100, samo [A-Za-z0-9_./:-] — ključ idempotencije
  "kupac": {
    "naziv": "Ana Primjer", "tip": "fizicka", "email": "ana@example.com",
    "oib": "…",                     // opcionalno; obavezno za eRačun
    "adresa": { "ulica": "…", "grad": "Split", "postanskiBroj": "21000", "drzava": "HR" }
  },
  "stavke": [{
    "naziv": "Ulaznica", "opis": "…",
    "kolicina": 2, "jedinicaMjere": "H87",   // UN/ECE Rec 20: H87 komad, C62 jedinica, HUR sat
    "netoCijena": "15.00",                    // BEZ PDV-a, po jedinici; string ili broj, 2 decimale
    "pdvStopa": 0                             // 25 | 13 | 5 | 0
  }]
}
```

- **Izdavatelj izvan sustava PDV-a:** sve `pdvStopa` moraju biti 0. Fiskal sam
  dodaje klauzulu čl. 90 st. 1 Zakona o PDV-u, pa je ne ponavljaj u `uvjeti`.
- **Izdavatelj u sustavu PDV-a:** `netoCijena` je cijena bez PDV-a. Ako
  naplaćuješ bruto iznos (npr. kroz Stripe), preračunaj ga u neto i provjeri da
  `iznosi.iznosSPdv` u odgovoru odgovara naplaćenom iznosu.
- `FISKALNI_B2C` traži prijavljen poslovni prostor i aktivan certifikat
  tenanta, inače **409**. `RACUN` i `PONUDA` ne idu u CIS.
- Račun za predujam (avans) API nema; `PREDRACUN` je nefiskalni predračun.

### Odgovor

`201` za novi račun, **`200` + zaglavlje `Idempotent-Replay: true`** za ponovljeni.

```jsonc
{
  "id": 42, "vanjskaReferenca": "narudzba-1042", "brojRacuna": "12/1/1",
  "tip": "fiskalni_b2c", "status": "izdano", "datumVrijeme": "…",
  "iznosi": { "neto": "30.00", "iznosBezPdv": "30.00", "pdv": "0.00", "iznosSPdv": "30.00", "dospijevaZaPlacanje": "30.00" },
  "pdf": "/api/v1/racun/42/pdf",
  "poslanoEmail": null,
  "zki": "…", "jir": "…", "fiskalniQr": "…",
  "fiskalizacija": { "status": "fiskaliziran" }   // ili "ceka_jir"
}
```

## Tri pravila za pouzdanu integraciju

1. **Idempotencija.** Pošalji stabilnu `vanjskaReferenca` (npr. ID narudžbe ili
   Stripe `payment_intent`) i istu vrijednost u zaglavlju `Idempotency-Key`.
   Ista referenca + isti sadržaj vraća isti račun. Ista referenca + **drukčiji**
   sadržaj daje `409` s `racunId`: račun već postoji, a ispravak ide stornom.
2. **Oporavak nakon timeouta.** Ako odgovor ne stigne (mreža, timeout, 5xx),
   račun je možda ipak izdan. Prvo `GET /racun?vanjskaReferenca=…` (vraća račun
   ili 404), tek onda javi grešku ili ponovi.
3. **`ceka_jir` nije greška.** Ako CIS ne odgovori, račun je izdan (ima broj i
   ZKI) sa statusom `ceka_jir`, a Fiskal sam dovršava JIR (cron svakih 15 min).
   **Ne izdaji novi račun**, samo zapiši status i kasnije osvježi s `GET /racun/:id`.

## Greške

```json
{ "greska": "Validacija nije prošla", "detalji": [{ "polje": "stavke.0.pdvStopa", "poruka": "…" }] }
```

| Kod | Značenje | Ponoviti? |
|---|---|---|
| 400 | validacija | ne: popravi podatke |
| 401 | ključ | ne |
| 404 | ne postoji | ne |
| 409 | sukob (ista referenca, drugi sadržaj → `racunId`) ili nije ispunjen preduvjet fiskalizacije | ne |
| 5xx / bez odgovora | privremeno | da, nakon `GET ?vanjskaReferenca` |

## Ostale rute

| Ruta | Namjena |
|---|---|
| `GET /racun/:id` | dohvat računa (npr. poll JIR-a) |
| `GET /racun?vanjskaReferenca=…` | račun po tvojoj referenci, ili 404 |
| `GET /racun?limit=&offset=` | popis |
| `GET /racun/:id/pdf` | PDF; traži Bearer, javnog linka nema |
| `POST /racun/:id/posalji` `{ "na"?: "…", "bezJir"?: true }` | e-mail s PDF-om (default `kupac.email`). `POST /racun` ga **ne** šalje sam. Dok fiskalni račun čeka JIR → `409`, `kod: "NEMA_JIR"`, osim uz `bezJir: true` (pošalji samo sa ZKI-jem, na izričit zahtjev). `GET /racun/:id` vraća `poslanoEmail: { kada, na }` ili `null` |
| `POST /racun/:id/storno` `{ vanjskaReferenca?, napomena?, operaterOib?, stavke?: [{ redak, kolicina? }] }` | storno fiskalnog računa; bez `stavke` cijeli, sa `stavke` djelomični (npr. `kolicina: "0.5"`) |
| `GET /postavke` | poslovni prostori, uređaji, operateri, PDV status |

Račun u web sučelju za ulogiranog korisnika tenanta:
`https://fiskal[-test].domovina.ai/app/dashboard/racun?id=<id>`.
