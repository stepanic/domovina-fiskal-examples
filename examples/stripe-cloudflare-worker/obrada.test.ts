// node --test examples/stripe-cloudflare-worker/*.test.ts   (Node ≥ 22.18, bez buildanja)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fiskalKlijent, FiskalGreska, type Racun } from './fiskal.ts';
import { obradiDogadaj, type Ovisnosti } from './obrada.ts';
import { centiUIznos, netoIzBruto, racunIzCheckoutSessiona, type StripeSession } from './stripe-u-racun.ts';

const POSTAVKE = { poslovniProstor: '1', naplatniUredaj: '1', operaterOib: '12345678903', pdvStopa: 0 };

const session: StripeSession & { payment_status: string } = {
  id: 'cs_test_a1',
  payment_intent: 'pi_test_123',
  payment_status: 'paid',
  currency: 'eur',
  amount_total: 3000,
  customer_details: {
    name: 'Ana Primjer',
    email: 'ana@example.com',
    address: { city: 'Split', country: 'HR', line1: 'Ulica 1', postal_code: '21000' },
  },
};
const stavke = [{ description: 'Ulaznica', quantity: 2, amount_total: 3000 }];

function racun(o: Partial<Racun> = {}): Racun {
  return {
    id: 7, vanjskaReferenca: 'stripe-pi_test_123', brojRacuna: '7/1/1', tip: 'fiskalni_b2c', status: 'izdano',
    datumVrijeme: '2027-01-01T10:00:00', valuta: 'EUR',
    iznosi: { neto: '30.00', iznosBezPdv: '30.00', pdv: '0.00', iznosSPdv: '30.00', dospijevaZaPlacanje: '30.00' },
    pdf: '/api/v1/racun/7/pdf', poslanoEmail: null, zki: 'z', jir: 'j', fiskalniQr: null,
    fiskalizacija: { status: 'fiskaliziran' }, ...o,
  };
}

/** Lažni fetch: red odgovora, bilježi pozive. */
function lazniFetch(odgovori: ({ status: number; json?: unknown; headers?: Record<string, string> } | Error)[]) {
  const pozivi: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    pozivi.push({ url, init });
    const o = odgovori.shift();
    if (!o) throw new Error('neočekivan poziv ' + url);
    if (o instanceof Error) throw o;
    return new Response(o.json === undefined ? '' : JSON.stringify(o.json), { status: o.status, headers: o.headers });
  }) as unknown as typeof fetch;
  return { f, pozivi };
}

function ovisnosti(f: typeof fetch, spremljeno: string[] = []): Ovisnosti {
  return {
    fiskal: fiskalKlijent({ baseUrl: 'https://fiskal-test.domovina.ai/api/v1/', apiKljuc: 'dfk_test', fetch: f }),
    postavke: POSTAVKE,
    stavkeSessiona: async () => stavke,
    spremiRacun: async (pi, r) => { spremljeno.push(`${pi}:${r.brojRacuna}`); },
    posaljiEmail: true,
    log: () => {},
  };
}

test('iznosi u centima bez float grešaka', () => {
  assert.equal(centiUIznos(1999), '19.99');
  assert.equal(centiUIznos(5), '0.05');
  assert.equal(centiUIznos(-1050), '-10.50');
  assert.equal(netoIzBruto(1250, 25), 1000);
  assert.equal(netoIzBruto(1250, 0), 1250);
});

test('Checkout Session → payload', () => {
  const p = racunIzCheckoutSessiona(session, stavke, POSTAVKE);
  assert.equal(p.tip, 'FISKALNI_B2C');
  assert.equal(p.vanjskaReferenca, 'stripe-pi_test_123');
  assert.equal(p.nacinPlacanja, 'KARTICA');
  assert.equal(p.valuta, 'EUR');
  assert.deepEqual(p.stavke, [{ naziv: 'Ulaznica', kolicina: 2, jedinicaMjere: 'H87', netoCijena: '15.00', pdvStopa: 0 }]);
  assert.deepEqual(p.kupac?.adresa, { drzava: 'HR', grad: 'Split', ulica: 'Ulica 1', postanskiBroj: '21000' });
});

test('popust koji se ne dijeli po komadu → jedan redak s ukupnim iznosom', () => {
  const p = racunIzCheckoutSessiona(session, [{ description: 'Ulaznica', quantity: 3, amount_total: 4000 }], POSTAVKE);
  assert.deepEqual(p.stavke[0], { naziv: '3 × Ulaznica', kolicina: 1, jedinicaMjere: 'H87', netoCijena: '40.00', pdvStopa: 0 });
});

test('webhook: izda račun s Idempotency-Key i pošalje e-mail', async () => {
  const { f, pozivi } = lazniFetch([{ status: 201, json: racun() }, { status: 200, json: { poslano: true } }]);
  const spremljeno: string[] = [];
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f, spremljeno));
  assert.equal(ishod.ponovi, false);
  assert.equal(pozivi[0].url, 'https://fiskal-test.domovina.ai/api/v1/racun');
  assert.equal((pozivi[0].init.headers as Record<string, string>)['Idempotency-Key'], 'stripe-pi_test_123');
  assert.equal(pozivi[1].url, 'https://fiskal-test.domovina.ai/api/v1/racun/7/posalji');
  assert.deepEqual(spremljeno, ['pi_test_123:7/1/1']);
});

test('ponovljeni webhook → isti račun (replay), e-mail se ne šalje ponovno', async () => {
  const { f, pozivi } = lazniFetch([{ status: 200, json: racun({ poslanoEmail: { kada: 'x', na: 'ana@example.com' } }), headers: { 'Idempotent-Replay': 'true' } }]);
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f));
  assert.match(ishod.poruka, /već izdan 7\/1\/1/);
  assert.equal(pozivi.length, 1);
});

test('timeout pa GET po referenci → račun je ipak izdan, nema drugog računa', async () => {
  const { f, pozivi } = lazniFetch([new Error('timeout'), { status: 200, json: racun({ poslanoEmail: { kada: 'x', na: 'a' } }) }]);
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f));
  assert.equal(ishod.ponovi, false);
  assert.equal(pozivi[1].url, 'https://fiskal-test.domovina.ai/api/v1/racun?vanjskaReferenca=stripe-pi_test_123');
});

test('5xx i računa nema → Stripe neka ponovi (500)', async () => {
  const { f } = lazniFetch([{ status: 502, json: { greska: 'Bad gateway' } }, { status: 404, json: { greska: 'ne postoji' } }]);
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f));
  assert.equal(ishod.ponovi, true);
});

test('400 validacija → ne ponavljati', async () => {
  const { f } = lazniFetch([{ status: 400, json: { greska: 'Validacija nije prošla', detalji: [{ polje: 'operaterOib', poruka: 'OIB…' }] } }]);
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f));
  assert.equal(ishod.ponovi, false);
});

test('čeka JIR → račun spremljen, e-mail se odgađa', async () => {
  const { f, pozivi } = lazniFetch([{ status: 201, json: racun({ jir: null, fiskalizacija: { status: 'ceka_jir' } }) }]);
  const ishod = await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } }, ovisnosti(f));
  assert.match(ishod.poruka, /čeka JIR/);
  assert.equal(pozivi.length, 1);
});

test('neplaćena session (odgođeno plaćanje) → još bez računa', async () => {
  const { f, pozivi } = lazniFetch([]);
  await obradiDogadaj({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } }, ovisnosti(f));
  assert.equal(pozivi.length, 0);
});

test('puni povrat → storno s vlastitom referencom', async () => {
  const { f, pozivi } = lazniFetch([{ status: 200, json: racun() }, { status: 201, json: racun({ id: 8, brojRacuna: '8/1/1' }) }]);
  const charge = { id: 'ch_1', payment_intent: 'pi_test_123', amount: 3000, amount_refunded: 3000 };
  const ishod = await obradiDogadaj({ id: 'evt_2', type: 'charge.refunded', data: { object: charge } }, ovisnosti(f));
  assert.match(ishod.poruka, /storniran 7\/1\/1 → 8\/1\/1/);
  assert.equal(pozivi[1].url, 'https://fiskal-test.domovina.ai/api/v1/racun/7/storno');
  assert.equal((pozivi[1].init.headers as Record<string, string>)['Idempotency-Key'], 'stripe-pi_test_123-storno');
});

test('FiskalGreska: privremena samo za mrežu i 5xx', () => {
  assert.equal(new FiskalGreska(0, 'x').privremena, true);
  assert.equal(new FiskalGreska(503, 'x').privremena, true);
  assert.equal(new FiskalGreska(409, 'x').privremena, false);
});
