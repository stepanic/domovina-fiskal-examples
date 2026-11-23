#!/usr/bin/env node
/**
 * Testovi GAS bundla u Node-u — bez Googlea i bez mreže.
 *
 *   node scripts/test-gas.mjs [slug]     # default primjer-konferencija-2027
 *
 * Bundle (gas/dist/<slug>/Code.gs) se izvrši u vm kontekstu sa stubovima za
 * Utilities, Logger, PropertiesService, SpreadsheetApp i UrlFetchApp.
 * UrlFetchApp je skriptiran po testu (red odgovora), pa se provjeravaju i
 * idempotencija, oporavak nakon timeouta i poruke grešaka.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildEvent } from './build-gas.mjs';

const slug = process.argv[2] || 'primjer-konferencija-2027';
const code = fs.readFileSync(buildEvent(slug), 'utf8');

function kontekst({ sheetId, odgovori = [], kljuc = 'dfk_' + 'a'.repeat(64) } = {}) {
  const pozivi = [];
  const ctx = {
    Logger: { log: () => {} },
    Utilities: {
      DigestAlgorithm: { SHA_1: 'sha1' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash(alg).update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      formatDate: (d) => d.toISOString(),
      sleep: () => {},
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'FISKAL_API_KEY' ? kljuc : null) }) },
    SpreadsheetApp: { getActive: () => ({ getId: () => sheetId }) },
    UrlFetchApp: {
      fetch(url, opcije) {
        pozivi.push({ url, opcije });
        const o = odgovori.shift();
        if (!o) throw new Error('Neočekivan poziv: ' + url);
        if (o.baci) throw new Error(o.baci);
        return {
          getResponseCode: () => o.code,
          getContentText: () => JSON.stringify(o.json ?? {}),
          getHeaders: () => o.headers ?? {},
        };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { ctx, pozivi };
}

let prolaz = 0;
function test(naziv, fn) {
  try { fn(); prolaz++; console.log('  ✓ ' + naziv); }
  catch (e) { console.error('  ✖ ' + naziv + '\n    ' + e.message.split('\n').join('\n    ')); process.exitCode = 1; }
}

const { ctx: c0 } = kontekst();
const okoline = c0.OKOLINE;
const TEST_SHEET = okoline.test.sheetId;

// ── parseCityAndCountry ─────────────────────────────────────────────────────
console.log('parseCityAndCountry');
const drzave = [
  // oblici koje je stari parser kvario: 'it' kao podniz (Lithuania → IT),
  // država u 3. segmentu, grad bez države, država bez zareza
  ['Vilnius, Lithuania', 'LT', 'Vilnius'],
  ['Austin, Texas, USA', 'US', 'Austin'],
  ['Tuzla ', 'BA', 'Tuzla'],
  ['Germany Augsburg ', 'DE', 'Augsburg'],
  // tipični oblici (SI, HR, DE)
  ['Ljubljana, Slovenia', 'SI', 'Ljubljana'],
  ['Zagreb, Hrvatska', 'HR', 'Zagreb'],
  ['Zagreb, Croatia', 'HR', 'Zagreb'],
  ['Split', 'HR', 'Split'],
  ['München, Deutschland', 'DE', 'München'],
  ['Augsburg, Germany', 'DE', 'Augsburg'],
  ['Regensburg, Bayern, Deutschland', 'DE', 'Regensburg'],
  // kratice i izvorni nazivi
  ['Mostar, BiH', 'BA', 'Mostar'],
  ['Wien, Österreich', 'AT', 'Wien'],
  // rubni
  ['Novi Sad', 'RS', 'Novi Sad'],
  ['Novi Sad, Srbija', 'RS', 'Novi Sad'],
  ['Rome, Italy', 'IT', 'Rome'],
  ['Vilnius, LT', 'LT', 'Vilnius'],
  ['Chicago, SAD', 'US', 'Chicago'],
  ['Croatia', 'HR', ''],
  ['Dublin, Ireland', 'IE', 'Dublin'],
  ['Sydney, Australia', 'AU', 'Sydney'],
  ['Graz, Austria', 'AT', 'Graz'],
  ['Nepoznatograd', 'HR', 'Nepoznatograd'],
  ['', 'HR', ''],
];
for (const [ulaz, drzava, grad] of drzave) {
  test(JSON.stringify(ulaz) + ' → ' + drzava, () => {
    const r = c0.parseCityAndCountry(ulaz);
    assert.equal(r.country, drzava);
    assert.equal(r.city, grad);
  });
}

// ── Payload ─────────────────────────────────────────────────────────────────
console.log('buildFiskalPayload_');
const C = c0.CONFIG.COLUMNS;
const headers = [C.TIMESTAMP, C.EMAIL, C.NAME, C.GENDER, C.CITY_COUNTRY, C.YEAR_OF_BIRTH, C.PAYMENT, C.PHONE, C.OCCUPATION, C.OIB, C.PAYMENT_TYPE, C.ACTION];
const vrijeme = new Date('2026-10-18T09:12:33Z');
const red = (o = {}) => headers.map((h) => (h in o ? o[h] : {
  [C.TIMESTAMP]: vrijeme, [C.EMAIL]: ' Ana.Test@Example.com ', [C.NAME]: 'Ana  Testić', [C.GENDER]: 'Female',
  [C.CITY_COUNTRY]: 'Vilnius, Lithuania', [C.YEAR_OF_BIRTH]: 1990, [C.PAYMENT]: 100, [C.PHONE]: '+370 600 00000',
  [C.OCCUPATION]: 'Nurse', [C.OIB]: '', [C.PAYMENT_TYPE]: '', [C.ACTION]: true,
}[h]));

const ocekivanaRef = c0.CONFIG.FISKAL.REFERENCE_PREFIX + '-' + crypto.createHash('sha1').update(vrijeme.getTime() + '|ana.test@example.com').digest('hex').slice(0, 16);

test('osnovna polja i referenca', () => {
  const p = c0.buildFiskalPayload_(headers, red());
  assert.equal(p.tip, 'FISKALNI_B2C');
  assert.equal(p.poslovniProstor, c0.CONFIG.FISKAL.POSLOVNI_PROSTOR);
  assert.equal(p.naplatniUredaj, c0.CONFIG.FISKAL.NAPLATNI_UREDAJ);
  assert.equal(p.operaterOib, c0.CONFIG.FISKAL.OPERATER_OIB);
  assert.equal(p.nacinPlacanja, 'TRANSAKCIJSKI');
  assert.equal(p.datumIsporuke, c0.CONFIG.CONFERENCE_DATE);
  assert.equal(p.vanjskaReferenca, ocekivanaRef);
  assert.match(p.vanjskaReferenca, /^[\w./:-]{1,100}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(p.kupac)), { naziv: 'Ana Testić', tip: 'fizicka', adresa: { drzava: 'LT', grad: 'Vilnius' }, email: 'Ana.Test@Example.com' });
  assert.equal(p.stavke.length, 1);
  assert.equal(p.stavke[0].netoCijena, 100);
  assert.equal(p.stavke[0].pdvStopa, 0);
  assert.equal(p.stavke[0].kolicina, 1);
  assert.match(p.internaBiljeska, /tel\. \+370/);
  assert.ok(!('oib' in p.kupac));
});

test('referenca ne ovisi o retku ni o velikim slovima e-maila', () => {
  const a = c0.buildFiskalPayload_(headers, red()).vanjskaReferenca;
  const b = c0.buildFiskalPayload_(headers, red({ [C.EMAIL]: 'ana.test@example.com', [C.PAYMENT]: '100,00' })).vanjskaReferenca;
  assert.equal(a, b);
  const d = c0.buildFiskalPayload_(headers, red({ [C.TIMESTAMP]: new Date(vrijeme.getTime() + 1000) })).vanjskaReferenca;
  assert.notEqual(a, d);
});

test('RAČUN dobiva vlastitu referencu (ne sukobljava se s fiskalnim)', () => {
  const p = c0.buildFiskalPayload_(headers, red(), 'RAČUN');
  assert.equal(p.tip, 'RACUN');
  assert.equal(p.vanjskaReferenca, ocekivanaRef + '-racun');
  assert.ok(!('operaterOib' in p));
});

test('bez uplate / bez vremenske oznake → greška', () => {
  assert.throws(() => c0.buildFiskalPayload_(headers, red({ [C.PAYMENT]: '' })), /UPLATA je prazan/);
  assert.throws(() => c0.buildFiskalPayload_(headers, red({ [C.TIMESTAMP]: '' })), /ključ računa/);
});

test('OIB i način plaćanja iz retka; lokalna validacija', () => {
  const p = c0.buildFiskalPayload_(headers, red({ [C.OIB]: '123 456 789 01', [C.PAYMENT_TYPE]: 'kartica' }));
  assert.equal(p.kupac.oib, '12345678901');
  assert.equal(p.nacinPlacanja, 'KARTICA');
  assert.equal(c0.validateFiskalPayload_(p).valid, true);
  const los = c0.buildFiskalPayload_(headers, red({ [C.OIB]: '123', [C.EMAIL]: 'nije-mail' }));
  const v = c0.validateFiskalPayload_(los);
  assert.equal(v.valid, false);
  assert.match(v.error, /OIB/);
  assert.match(v.error, /E-mail/);
});

// ── Okolina ─────────────────────────────────────────────────────────────────
console.log('fiskalOkolina_');
test('TEST Sheet → fiskal-test', () => {
  const { ctx } = kontekst({ sheetId: TEST_SHEET });
  assert.equal(ctx.fiskalOkolina_().naziv, 'test');
  assert.equal(ctx.fiskalOkolina_().baseUrl, 'https://fiskal-test.domovina.ai/api/v1');
});
test('PROD Sheet → fiskal (PROD)', () => {
  const { ctx } = kontekst({ sheetId: okoline.prod.sheetId });
  assert.equal(ctx.fiskalOkolina_().baseUrl, 'https://fiskal.domovina.ai/api/v1');
});
test('nepoznat Sheet (npr. nova kopija) → odbija', () => {
  const { ctx } = kontekst({ sheetId: 'kopija-xyz' });
  assert.throws(() => ctx.fiskalOkolina_(), /nije TEST ni PROD/);
});
test('dashboard link', () => {
  const { ctx } = kontekst({ sheetId: TEST_SHEET });
  assert.equal(ctx.fiskalDashboardUrl_(42), 'https://fiskal-test.domovina.ai/app/dashboard/racun?id=42');
});

// ── sendToFiskal_ ───────────────────────────────────────────────────────────
console.log('sendToFiskal_');
const racun = { id: 7, brojRacuna: '8/2/1', tip: 'fiskalni_b2c', jir: 'abcdef12-3456', fiskalizacija: { status: 'fiskaliziran' } };

test('201 → novi; Idempotency-Key = vanjskaReferenca; Bearer', () => {
  const { ctx, pozivi } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ code: 201, json: racun }] });
  const p = ctx.buildFiskalPayload_(headers, red());
  const r = ctx.sendToFiskal_(p);
  assert.equal(r.ponovljen, false);
  assert.equal(r.racun.id, 7);
  assert.equal(pozivi[0].url, 'https://fiskal-test.domovina.ai/api/v1/racun');
  assert.equal(pozivi[0].opcije.method, 'post');
  assert.equal(pozivi[0].opcije.headers['Idempotency-Key'], p.vanjskaReferenca);
  assert.match(pozivi[0].opcije.headers.Authorization, /^Bearer dfk_/);
  assert.deepEqual(JSON.parse(pozivi[0].opcije.payload), JSON.parse(JSON.stringify(p)));
});

test('200 + Idempotent-Replay → ponovljen', () => {
  const { ctx } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ code: 200, json: racun, headers: { 'idempotent-replay': 'true' } }] });
  assert.equal(ctx.sendToFiskal_(ctx.buildFiskalPayload_(headers, red())).ponovljen, true);
});

test('timeout → GET ?vanjskaReferenca nađe račun (oporavljen, bez novog POST-a)', () => {
  const { ctx, pozivi } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ baci: 'Timeout' }, { code: 200, json: racun }] });
  const p = ctx.buildFiskalPayload_(headers, red());
  const r = ctx.sendToFiskal_(p);
  assert.equal(r.oporavljen, true);
  assert.equal(pozivi.length, 2);
  assert.equal(pozivi[1].opcije.method, 'get');
  assert.ok(pozivi[1].url.endsWith('/racun?vanjskaReferenca=' + p.vanjskaReferenca));
});

test('timeout i račun ne postoji → greška (ne izdaje se drugi)', () => {
  const { ctx, pozivi } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ baci: 'Timeout' }, { code: 404, json: { greska: 'ne postoji' } }] });
  assert.throws(() => ctx.sendToFiskal_(ctx.buildFiskalPayload_(headers, red())), /nije odgovorio/);
  assert.equal(pozivi.length, 2);
});

test('409 sukob → poruka o drukčijim podacima', () => {
  const { ctx } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ code: 409, json: { greska: 'vanjskaReferenca je već iskorištena za drukčiji račun', racunId: 5 } }] });
  assert.throws(() => ctx.sendToFiskal_(ctx.buildFiskalPayload_(headers, red())), /DRUKČIJIM podacima[\s\S]*storno/);
});

test('400 → greska + detalji', () => {
  const { ctx } = kontekst({ sheetId: TEST_SHEET, odgovori: [{ code: 400, json: { greska: 'Validacija nije prošla', detalji: [{ polje: 'kupac.email', poruka: 'nije valjana' }] } }] });
  assert.throws(() => ctx.sendToFiskal_(ctx.buildFiskalPayload_(headers, red())), /kupac\.email: nije valjana/);
});

test('ceka_jir → status „čeka JIR”', () => {
  assert.equal(c0.fiskalStatusRacuna_({ fiskalizacija: { status: 'ceka_jir' } }), 'IZDAN – čeka JIR');
  assert.equal(c0.fiskalOpisRacuna_({ brojRacuna: '1/2/1', tip: 'fiskalni_b2c' }), '1/2/1 · čeka JIR');
  assert.equal(c0.fiskalOpisRacuna_(racun), '8/2/1 · JIR abcdef12…');
});

// Payload za vanjsku provjeru sheme (scripts/test-shema.sh)
if (process.env.ISPIS_PAYLOAD) {
  fs.writeFileSync(process.env.ISPIS_PAYLOAD, JSON.stringify([
    c0.buildFiskalPayload_(headers, red()),
    c0.buildFiskalPayload_(headers, red({ [C.OIB]: '98765432106', [C.CITY_COUNTRY]: 'Mostar, BiH' })),
  ], null, 2));
}

console.log(`\n${process.exitCode ? '✖ PALO' : '✓ sve prošlo'} (${prolaz} prošlo)`);
