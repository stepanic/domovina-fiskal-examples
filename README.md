# Domovina Fiskal: primjeri integracije

Primjeri kako izdavati **hrvatske fiskalizirane račune** (ZKI/JIR, CIS) kroz
[Domovina Fiskal](https://github.com/domovinatv/domovina-fiskal), open-source
servis za fiskalizaciju i eRačun, iz alata koje već koristiš.

> **English summary.** Example integrations for the Domovina Fiskal API
> (Croatian fiscalised invoices): a Google Forms → Sheets → Apps Script flow for
> event registrations, and a TypeScript Cloudflare Worker that issues an invoice
> from a Stripe webhook. Both rely on idempotency keys, so retries never create
> duplicate invoices. Docs are in Croatian, because the fiscalisation rules are.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Što je unutra

| Primjer | Za koga | Ulaz |
|---|---|---|
| **Stripe → fiskalni račun** ([`examples/stripe-cloudflare-worker`](examples/stripe-cloudflare-worker)) | webshop, ulaznice, članarine: račun automatski nakon uspješnog plaćanja karticom | [README](examples/stripe-cloudflare-worker/README.md) |
| **Google Forms → Sheets → račun** ([`gas/`](gas)) | eventi i kotizacije: prijave kroz formu, organizator upiše uplatu i klikne checkbox | [docs/google-forms.md](docs/google-forms.md) |
| **API ukratko** | svi | [docs/api.md](docs/api.md) |

## API u 30 sekundi

```bash
curl -X POST https://fiskal-test.domovina.ai/api/v1/racun \
  -H "Authorization: Bearer $FISKAL_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: narudzba-1042" \
  -d '{
    "tip": "FISKALNI_B2C",
    "poslovniProstor": "1", "naplatniUredaj": "1", "operaterOib": "12345678903",
    "nacinPlacanja": "KARTICA",
    "vanjskaReferenca": "narudzba-1042",
    "kupac": { "naziv": "Ana Primjer", "email": "ana@example.com" },
    "stavke": [{ "naziv": "Ulaznica", "kolicina": 2, "netoCijena": "15.00", "pdvStopa": 0 }]
  }'
```

Odgovor sadrži `brojRacuna` (npr. `12/1/1`), `zki`, `jir` i `fiskalizacija.status`.
Isti zahtjev poslan ponovno vraća **isti** račun (`200`, `Idempotent-Replay: true`).

Tri pravila koja svaka integracija mora poštovati:

1. **Stabilna `vanjskaReferenca`** (ID narudžbe, Stripe `payment_intent`, hash
   retka) i isto u `Idempotency-Key`. Ponavljanje je tada uvijek sigurno.
2. **Nakon timeouta ili 5xx prvo `GET /racun?vanjskaReferenca=…`**, jer je
   račun možda izdan.
3. **`fiskalizacija.status: "ceka_jir"` je uspjeh.** Račun je izdan, a JIR
   Fiskal dovršava sam. Ne izdaji novi.

## Brzi start

```bash
git clone https://github.com/stepanic/domovina-fiskal-examples
cd domovina-fiskal-examples
npm test     # Apps Script bundle u Node vm-u + Stripe primjer, bez mreže
```

Za provjeru payloada pravom zod shemom Fiskala klonaj i
[`domovina-fiskal`](https://github.com/domovinatv/domovina-fiskal) pored ovog
repoa (`cd ../domovina-fiskal/backend && npm ci`). Bez njega se taj korak preskače.

## Struktura

```
docs/
  api.md                    API: izdavanje, idempotencija, greške, storno, e-mail
  google-forms.md           postupak za novi event (TEST → PROD)
examples/stripe-cloudflare-worker/
  fiskal.ts                 klijent bez ovisnosti (fetch)
  stripe-u-racun.ts         Checkout Session → račun
  obrada.ts                 logika webhooka (izdaj / storno / ponovi)
  worker.ts                 Hono + provjera Stripe potpisa
gas/
  modules/DomovinaFiskal.gs adapter za Apps Script: izdavanje, bulk, e-mail, storno
  modules/Mapping.gs        čitanje Sheeta, izbornik, parser „Mjesto i država” → ISO kod
  events/primjer-konferencija-2027/
    Config.gs               konfiguracija jednog eventa (izmišljeni podaci)
    okoline.json            TEST/PROD Sheet ↔ Fiskal base URL
scripts/
  build-gas.mjs             Config + moduli → jedan Code.gs po eventu
  push-gas.mjs              clasp push u bound projekt (PROD traži --da-prod)
  test-gas.mjs              testovi bundla sa stubovima Google servisa
  test-shema.sh             payload kroz pravu shemu domovina-fiskal
  fiskal-postavke.sh        read-only GET /postavke
```

## Okoline

| | Base URL | |
|---|---|---|
| TEST | `https://fiskal-test.domovina.ai/api/v1` | CIS TEST, računi nisu stvarni: tu sve isprobaj |
| PROD | `https://fiskal.domovina.ai/api/v1` | pravi CIS: **svaki fiskalni račun je stvaran** i može se samo stornirati |

API ključ dobivaš po tenantu (izdavatelju), posebno za TEST i PROD. Ključ ide u
secrete (Script Properties, `wrangler secret`, env), nikad u kod ni u git.

## Odakle ovo

Google Sheets dio nastao je iz
[`fira-forms-connector`](https://github.com/stepanic/fira-forms-connector)
(ista integracija za FIRA.finance): `Mapping.gs` i dalje podržava oba
providera (`CONFIG.PROVIDER`). Svi podaci u primjerima (izdavatelj, OIB-i,
kupci, Sheet ID-evi) su izmišljeni.

## Licenca

[MIT](LICENSE)
