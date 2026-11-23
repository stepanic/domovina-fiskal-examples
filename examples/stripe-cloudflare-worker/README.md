# Fiskalni račun nakon Stripe plaćanja (Cloudflare Worker + Hono)

Webshop, prodaja ulaznica, članarine: kupac plati kroz **Stripe Checkout**, a
backend iz webhooka izda **fiskalni račun** u Domovina Fiskalu i pošalje ga
kupcu e-mailom. Kod je TypeScript bez ovisnosti u Fiskal dijelu (samo `fetch`),
pa se `fiskal.ts` može kopirati u bilo koji Node/Workers/Deno projekt.

```
Stripe Checkout ──webhook──▶ Worker /stripe/webhook
                               │ provjeri potpis
                               │ checkout.session.completed (paid)
                               ▼
                    POST /api/v1/racun  (Idempotency-Key: stripe-<payment_intent>)
                               │
                 201 / 200 replay ──▶ spremi id, broj, JIR uz narudžbu
                               │
                 POST /racun/:id/posalji  (PDF kupcu; tek kad ima JIR)

charge.refunded (cijeli iznos) ──▶ POST /racun/:id/storno
```

## Datoteke

| Datoteka | Što radi |
|---|---|
| [`fiskal.ts`](fiskal.ts) | klijent: `izdaj` (idempotencija + oporavak nakon timeouta), `racunPoReferenci`, `posalji`, `storno`, `pdf`; `FiskalGreska` s `privremena` |
| [`stripe-u-racun.ts`](stripe-u-racun.ts) | čista funkcija: Checkout Session + line items → tijelo `POST /racun`; centi → iznos, bruto → neto |
| [`obrada.ts`](obrada.ts) | logika webhooka bez frameworka: koji event, kada izdati, kada storno, kada reći Stripeu da ponovi |
| [`worker.ts`](worker.ts) | Hono ruta, provjera Stripe potpisa (`constructEventAsync` + SubtleCrypto), spajanje ovisnosti |
| [`obrada.test.ts`](obrada.test.ts) | 12 testova s lažnim `fetch`: replay, timeout, 5xx, 400, čeka JIR, odgođeno plaćanje, storno |

```bash
npm install
npm test          # node --test, bez mreže
npm run typecheck
cp .dev.vars.example .dev.vars   # upiši TEST ključeve
npm run dev
stripe listen --forward-to localhost:8787/stripe/webhook
stripe trigger checkout.session.completed
```

## Odluke koje vrijedi preuzeti

**Ključ idempotencije = Stripe `payment_intent`.** `vanjskaReferenca` i
`Idempotency-Key` su `stripe-<payment_intent>`. Stripe isti event zna poslati
više puta, a `completed` i `async_payment_succeeded` dolaze za istu uplatu.
Fiskal za istu referencu vrati **isti** račun, pa duplikata nema. Ista referenca
služi i za pronalazak računa kod povrata (`charge.refunded` nosi
`payment_intent`). Ako narudžba u tvojoj bazi ima vlastiti ID, i on je dobar
ključ, samo mora biti stabilan i jedinstven po uplati.

**Stripeovi retryji kao red čekanja.** Kad Fiskal nije dostupan (mreža, 5xx),
webhook vrati 500 i Stripe ga ponavlja do 3 dana. To je sigurno zbog
idempotencije. Prije nego što prijavi grešku, klijent pita `GET
/racun?vanjskaReferenca=…`, jer je račun možda izdan, a samo je odgovor izgubljen.
Greške 4xx (validacija, krivi OIB, 409) se ponavljanjem ne popravljaju: webhook
vrati 200, a greška ide u log da je čovjek pogleda.

**`ceka_jir` je uspjeh.** Ako CIS ne odgovori, Fiskal svejedno izda račun (broj
+ ZKI) i sam dovrši JIR. Spremi račun kao izdan i **ne izdaji novi**. E-mail s
računom Fiskal šalje tek kad postoji JIR (inače `409 NEMA_JIR`), pa ga u tom
slučaju pošalji iz svog crona: `GET /racun/:id` → kad ima `jir` →
`POST /racun/:id/posalji`. Ako kupac mora dobiti račun odmah, `posalji(id, { bezJir: true })`
pošalje ga samo sa ZKI-jem, ali to je iznimka, ne zadano ponašanje.

**Odgođena plaćanja.** Za SEPA i slične metode `checkout.session.completed`
stiže s `payment_status: 'unpaid'`. Račun se tada izdaje tek na
`checkout.session.async_payment_succeeded`.

**Iznosi u centima.** Stripe radi u centima, a Fiskal prima string s 2
decimale. `centiUIznos(1999) === '19.99'`, bez float aritmetike.

**PDV.** Stripe naplaćuje bruto, a Fiskal prima **neto** cijenu i sam računa
PDV. Za izdavatelja izvan sustava PDV-a (`FISKAL_PDV_STOPA=0`) neto je isto što
i bruto. Za izdavatelja u sustavu PDV-a primjer preračuna bruto u neto i nakon
izdavanja usporedi `iznosi.iznosSPdv` s naplaćenim iznosom (`provjeriIznos`).
Ako se ne poklapa, zapiše upozorenje. Najčišće je držati neto cijene u svom
katalogu i iz njih slagati i Stripe cijenu i stavke računa.

**Popusti.** Ako se `amount_total` retka ne dijeli točno s količinom (kupon na
cijelu narudžbu), primjer izda jedan redak „3 × Ulaznica” s ukupnim iznosom,
da zbroj na računu bude točno naplaćeni iznos.

**Povrat novca.** Puni povrat znači storno cijelog računa s referencom
`stripe-<pi>-storno`, koji je isto idempotentan. Djelomični povrat primjer samo
zabilježi. Fiskal storno ide po retcima i količinama (`stavke: [{ redak,
kolicina }]`), a koja je ulaznica vraćena zna samo tvoja domena.

**PDF kupcu.** `GET /racun/:id/pdf` traži Bearer ključ, javnog linka nema. Za
„preuzmi račun” na stranici narudžbe napravi rutu u svom backendu koja provjeri
kupca i proxya `fiskal.pdf(id)`.

## Prije PROD-a

- TEST: `FISKAL_BASE_URL=https://fiskal-test.domovina.ai/api/v1`, Stripe test mode.
  Prođi kupnju, ponovljeni webhook (`stripe events resend <evt>`), povrat.
- PROD: drugi API ključ, `https://fiskal.domovina.ai/api/v1`, Stripe live mode.
  **Svaki PROD račun ide u CIS** i ne može se obrisati, samo stornirati.

Detalji API-ja: [`../../docs/api.md`](../../docs/api.md).
