/**
 * Domovina Fiskal adapter (CONFIG.PROVIDER === 'DOMOVINA_FISKAL').
 *
 * Mapping.gs ostaje FIRA tok; kad je provider Fiskal, njegove ulazne točke
 * (izdavanje, bulk, postavke, stupci) prosljeđuju ovamo. API: docs/api.md.
 *
 * Okolina se NE upisuje ručno: build ubacuje OKOLINE (sheetId → base URL)
 * iz gas/events/<slug>/okoline.json, a skripta je bira po ID-u Sheeta u kojem
 * radi. DEV kopija Sheeta zato ne može izdati PROD račun ni obrnuto.
 * Script Properties: FISKAL_API_KEY (ključ te okoline).
 *
 * Idempotencija: vanjskaReferenca = Idempotency-Key =
 *   <REFERENCE_PREFIX>-<sha1(vremenska oznaka | e-mail) prvih 16 hex>
 * Ponovljeni zahtjev (dupli klik, ponovljeni bulk, timeout) vraća ISTI račun.
 *
 * Stupci koje skripta piše (dodaje ih sama ako ne postoje):
 *   Fiskal Status · Fiskal Vrijeme · Fiskal Račun (link) · Fiskal ID ·
 *   Fiskal E-mail · Fiskal Storno
 */

var FISKAL_STUPCI_ = {
  STATUS: 'Fiskal Status',
  VRIJEME: 'Fiskal Vrijeme',
  RACUN: 'Fiskal Račun',
  ID: 'Fiskal ID',
  EMAIL: 'Fiskal E-mail',
  STORNO: 'Fiskal Storno'
};

var FISKAL_STATUS_ = {
  IZDAN: 'IZDAN',
  CEKA_JIR: 'IZDAN – čeka JIR',
  GRESKA: 'GREŠKA'
};

// Vokabular u Sheetu (isti kao kod FIRA eventa) → Fiskal tip
var FISKAL_TIP_ = {
  'FISKALNI_RAČUN': 'FISKALNI_B2C',
  'RAČUN': 'RACUN',
  'PONUDA': 'PONUDA'
};

// Bulk staje prije GAS limita od 6 min; ponovno pokretanje nastavlja.
var FISKAL_BULK_BUDZET_MS_ = 4.5 * 60 * 1000;

function jeFiskal_() {
  return CONFIG.PROVIDER === 'DOMOVINA_FISKAL';
}

// ============================================================================
// OKOLINA I KLJUČ
// ============================================================================

/**
 * { naziv: 'test'|'prod', baseUrl, sheetId } za Sheet u kojem skripta radi.
 * Baca grešku ako Sheet nije ni TEST ni PROD Sheet iz okoline.json.
 */
function fiskalOkolina_() {
  var id = SpreadsheetApp.getActive().getId();
  if (typeof OKOLINE !== 'undefined') {
    for (var naziv in OKOLINE) {
      if (OKOLINE[naziv].sheetId === id) {
        return { naziv: naziv, baseUrl: OKOLINE[naziv].fiskalBaseUrl.replace(/\/+$/, ''), sheetId: id };
      }
    }
  }
  throw new Error('Ovaj Sheet (' + id + ') nije TEST ni PROD Sheet ovog eventa (okoline.json). ' +
    'Skripta ne zna na koju Fiskal okolinu smije slati — ne izdajem ništa.');
}

function fiskalKljuc_() {
  var k = PropertiesService.getScriptProperties().getProperty('FISKAL_API_KEY');
  if (!k) throw new Error('Fiskal API ključ nije postavljen: izbornik → ⚙️ Postavi API ključ');
  return k;
}

function fiskalOznakaOkoline_(okolina) {
  return okolina.naziv === 'prod' ? '🔴 PROD (pravi CIS — račun je stvaran)' : '🧪 TEST (CIS TEST)';
}

function fiskalPostaviKljuc() {
  var ui = SpreadsheetApp.getUi();
  var okolina;
  try { okolina = fiskalOkolina_(); } catch (e) { ui.alert('❌ Okolina', e.message, ui.ButtonSet.OK); return; }
  var r = ui.prompt(
    'Domovina Fiskal API ključ — ' + okolina.naziv.toUpperCase(),
    'Okolina: ' + fiskalOznakaOkoline_(okolina) + '\n' + okolina.baseUrl + '\n\n' +
    'Unesite API ključ ove okoline (dfk_…):',
    ui.ButtonSet.OK_CANCEL
  );
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var kljuc = r.getResponseText().trim();
  if (!/^dfk_[0-9a-f]{64}$/.test(kljuc)) {
    ui.alert('❌ Ključ mora biti oblika dfk_ + 64 hex znaka. Nije spremljen.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('FISKAL_API_KEY', kljuc);
  // Provjera ključa jeftinim GET-om
  var odg = fiskalZahtjev_('get', '/postavke');
  if (odg.code === 200) {
    ui.alert('✅ Ključ spremljen i radi', 'Okolina: ' + fiskalOznakaOkoline_(okolina), ui.ButtonSet.OK);
  } else {
    ui.alert('⚠️ Ključ spremljen, ali provjera nije prošla', fiskalPorukaGreske_(odg), ui.ButtonSet.OK);
  }
}

function fiskalPrikaziPostavke() {
  var ui = SpreadsheetApp.getUi();
  var okolina, okolinaTekst;
  try { okolina = fiskalOkolina_(); okolinaTekst = fiskalOznakaOkoline_(okolina) + '\n' + okolina.baseUrl; }
  catch (e) { okolinaTekst = '❌ ' + e.message; }
  var k = PropertiesService.getScriptProperties().getProperty('FISKAL_API_KEY');
  ui.alert('Postavke — Domovina Fiskal',
    'Okolina: ' + okolinaTekst + '\n' +
    'API ključ: ' + (k ? '…' + k.slice(-4) : 'NIJE POSTAVLJEN') + '\n\n' +
    'Usluga: ' + CONFIG.SERVICE_NAME + '\n' +
    'Cijena: iz stupca "' + CONFIG.COLUMNS.PAYMENT + '" (obavezno)\n' +
    'Datum isporuke: ' + CONFIG.CONFERENCE_DATE + '\n' +
    'Prostor/uređaj: ' + CONFIG.FISKAL.POSLOVNI_PROSTOR + '/' + CONFIG.FISKAL.NAPLATNI_UREDAJ + '\n' +
    'Plaćanje (default): ' + CONFIG.DEFAULT_PAYMENT_TYPE + '\n' +
    'Auto e-mail kupcu: ' + (CONFIG.FISKAL.AUTO_EMAIL ? 'DA' : 'NE (ručno iz izbornika)') + '\n' +
    'Tab: ' + CONFIG.SHEET_NAME,
    ui.ButtonSet.OK);
}

// ============================================================================
// HTTP
// ============================================================================

/**
 * Jedan poziv Fiskal API-ja. Nikad ne baca zbog HTTP statusa; mrežna greška /
 * timeout → { code: 0, greska }.
 * @returns {{code:number, json:Object|null, tekst:string, replay:boolean, greska?:string}}
 */
function fiskalZahtjev_(metoda, putanja, tijelo, idempotencyKey) {
  var okolina = fiskalOkolina_();
  var opcije = {
    method: metoda,
    headers: { Authorization: 'Bearer ' + fiskalKljuc_() },
    muteHttpExceptions: true
  };
  if (tijelo !== undefined) {
    opcije.contentType = 'application/json';
    opcije.payload = JSON.stringify(tijelo);
  }
  if (idempotencyKey) opcije.headers['Idempotency-Key'] = idempotencyKey;

  var url = okolina.baseUrl + putanja;
  Logger.log('FISKAL ' + metoda.toUpperCase() + ' ' + url + (tijelo !== undefined ? '\n' + JSON.stringify(tijelo, null, 2) : ''));

  var odg;
  try {
    odg = UrlFetchApp.fetch(url, opcije);
  } catch (e) {
    Logger.log('FISKAL mrežna greška: ' + e.message);
    return { code: 0, json: null, tekst: '', replay: false, greska: e.message };
  }
  var tekst = odg.getContentText();
  var json = null;
  try { json = JSON.parse(tekst); } catch (e) { /* PDF ili HTML */ }
  var zaglavlja = odg.getHeaders() || {};
  var replay = false;
  for (var h in zaglavlja) {
    if (h.toLowerCase() === 'idempotent-replay' && String(zaglavlja[h]).toLowerCase() === 'true') replay = true;
  }
  Logger.log('FISKAL ← HTTP ' + odg.getResponseCode() + (replay ? ' (replay)' : '') + '\n' + tekst.slice(0, 4000));
  return { code: odg.getResponseCode(), json: json, tekst: tekst, replay: replay };
}

/** Čitljiva poruka iz Fiskal greške: `greska` + `detalji[]`. */
function fiskalPorukaGreske_(odg) {
  if (odg.code === 0) return 'Fiskal nije odgovorio (' + (odg.greska || 'mreža/timeout') + ')';
  var opis = {
    400: 'Neispravni podaci', 401: 'API ključ ne vrijedi (provjeri ključ i okolinu)',
    404: 'Ne postoji', 409: 'Sukob', 501: 'Nije podržano', 502: 'Slanje nije uspjelo',
    503: 'Usluga nije konfigurirana', 500: 'Greška Fiskal servera'
  }[odg.code] || ('HTTP ' + odg.code);
  var j = odg.json || {};
  var dijelovi = [opis + (j.greska ? ': ' + j.greska : '')];
  (j.detalji || []).forEach(function(d) { dijelovi.push('  • ' + d.polje + ': ' + d.poruka); });
  if (j.racunId) dijelovi.push('  postojeći dokument id ' + j.racunId);
  if (j.id && odg.code >= 500) dijelovi.push('  id greške: ' + j.id);
  if (!odg.json && odg.tekst) dijelovi.push(odg.tekst.slice(0, 300));
  return dijelovi.join('\n');
}

// ============================================================================
// PAYLOAD
// ============================================================================

function hex_(bajtovi) {
  return bajtovi.map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/** Stabilan ključ retka: ne ovisi o broju retka (redovi se smiju ručno premještati). */
function fiskalReferenca_(vremenskaOznaka, email, sheetTip) {
  var vo = vremenskaOznaka && typeof vremenskaOznaka.getTime === 'function' ? String(vremenskaOznaka.getTime()) : String(vremenskaOznaka || '').trim();
  var em = String(email || '').trim().toLowerCase();
  if (!vo || !em) throw new Error('Za ključ računa trebaju "' + CONFIG.COLUMNS.TIMESTAMP + '" i "' + CONFIG.COLUMNS.EMAIL + '" — redak ih nema.');
  var hash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, vo + '|' + em, Utilities.Charset.UTF_8)).slice(0, 16);
  // Fiskalni bez sufiksa; ostali tipovi dobivaju svoj, da ne dođu u sukob s fiskalnim
  var sufiks = sheetTip && sheetTip !== 'FISKALNI_RAČUN' ? '-' + FISKAL_TIP_[sheetTip].toLowerCase() : '';
  return CONFIG.FISKAL.REFERENCE_PREFIX + '-' + hash + sufiks;
}

function fiskalInternaBiljeska_(data) {
  var dijelovi = [
    'Google Forms',
    getVal(data, CONFIG.COLUMNS.PHONE) ? 'tel. ' + getVal(data, CONFIG.COLUMNS.PHONE) : null,
    getVal(data, CONFIG.COLUMNS.GENDER) || null,
    getVal(data, CONFIG.COLUMNS.YEAR_OF_BIRTH) ? 'r. ' + getVal(data, CONFIG.COLUMNS.YEAR_OF_BIRTH) : null,
    getVal(data, CONFIG.COLUMNS.OCCUPATION) || null
  ].filter(Boolean);
  var t = dijelovi.join(' | ');
  return t.length > 2000 ? t.slice(0, 1997) + '...' : t;
}

/**
 * Redak Sheeta → tijelo POST /racun.
 * @param {string} [invoiceTypeOverride] 'FISKALNI_RAČUN' | 'RAČUN' | 'PONUDA'
 */
function buildFiskalPayload_(headers, rowData, invoiceTypeOverride) {
  var data = mapHeadersToValues(headers, rowData);

  var sheetTip = invoiceTypeOverride || getVal(data, CONFIG.COLUMNS.INVOICE_TYPE) || CONFIG.DEFAULT_INVOICE_TYPE;
  if (!FISKAL_TIP_[sheetTip]) throw new Error('Nepoznat tip dokumenta "' + sheetTip + '" (FISKALNI_RAČUN | RAČUN | PONUDA)');

  var uplata = validatePaymentAmount(data[CONFIG.COLUMNS.PAYMENT]);
  if (!uplata.valid) throw new Error(uplata.message);

  var email = String(getVal(data, CONFIG.COLUMNS.EMAIL)).trim();
  var ime = String(getVal(data, CONFIG.COLUMNS.NAME)).trim().replace(/\s+/g, ' ');
  var lokacija = parseCityAndCountry(getVal(data, CONFIG.COLUMNS.CITY_COUNTRY));
  var oib = String(getVal(data, CONFIG.COLUMNS.OIB)).replace(/\s/g, '');
  var nacin = String(getVal(data, CONFIG.COLUMNS.PAYMENT_TYPE) || CONFIG.DEFAULT_PAYMENT_TYPE).trim().toUpperCase();
  var termin = resolveTerminOverride_(data);
  var referenca = fiskalReferenca_(data[CONFIG.COLUMNS.TIMESTAMP], email, sheetTip);

  var adresa = { drzava: lokacija.country };
  if (lokacija.city) adresa.grad = lokacija.city.slice(0, 100);

  var kupac = { naziv: ime, tip: 'fizicka', adresa: adresa };
  if (email) kupac.email = email;
  if (oib) kupac.oib = oib;

  var stavka = {
    naziv: termin.serviceName,
    opis: 'Participant / Sudionik: ' + ime,
    kolicina: 1,
    jedinicaMjere: CONFIG.FISKAL.JEDINICA_MJERE,
    netoCijena: uplata.amount,
    pdvStopa: CONFIG.VAT_ENABLED ? CONFIG.DEFAULT_TAX_RATE * 100 : 0
  };
  if (CONFIG.DEFAULT_KPD_CODE) stavka.kpd = CONFIG.DEFAULT_KPD_CODE;

  var payload = {
    tip: FISKAL_TIP_[sheetTip],
    poslovniProstor: CONFIG.FISKAL.POSLOVNI_PROSTOR,
    naplatniUredaj: CONFIG.FISKAL.NAPLATNI_UREDAJ,
    nacinPlacanja: nacin,
    valuta: CONFIG.DEFAULT_CURRENCY,
    datumIsporuke: termin.conferenceDate,
    uvjeti: CONFIG.UVJETI,
    internaBiljeska: fiskalInternaBiljeska_(data),
    vanjskaReferenca: referenca,
    kupac: kupac,
    stavke: [stavka]
  };
  if (payload.tip === 'FISKALNI_B2C') payload.operaterOib = CONFIG.FISKAL.OPERATER_OIB;
  return payload;
}

/** Lokalna provjera prije slanja — server ionako validira, ovo daje bolju poruku. */
function validateFiskalPayload_(p) {
  var g = [];
  if (!p.kupac.naziv) g.push('Ime i prezime je prazno');
  if (!p.kupac.email) g.push('E-mail je prazan');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.kupac.email)) g.push('E-mail "' + p.kupac.email + '" nije valjan');
  if (p.kupac.oib && !/^\d{11}$/.test(p.kupac.oib)) g.push('OIB "' + p.kupac.oib + '" mora imati 11 znamenki (ili ostavi prazno)');
  if (['GOTOVINA', 'KARTICA', 'TRANSAKCIJSKI', 'OSTALO'].indexOf(p.nacinPlacanja) === -1) {
    g.push('Način plaćanja "' + p.nacinPlacanja + '" — dopušteno GOTOVINA, KARTICA, TRANSAKCIJSKI, OSTALO');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.datumIsporuke)) g.push('CONFIG.CONFERENCE_DATE mora biti YYYY-MM-DD');
  return g.length ? { valid: false, error: g.join('\n') } : { valid: true };
}

// ============================================================================
// IZDAVANJE
// ============================================================================

/**
 * POST /racun s idempotencijom. Ako Fiskal ne odgovori (timeout, 5xx),
 * pita GET ?vanjskaReferenca — račun je možda ipak izdan.
 * @returns {{racun:Object, ponovljen:boolean, oporavljen:boolean}}
 * @throws Error s porukom za korisnika
 */
function sendToFiskal_(payload) {
  var odg = fiskalZahtjev_('post', '/racun', payload, payload.vanjskaReferenca);
  if (odg.code === 201 || odg.code === 200) {
    return { racun: odg.json, ponovljen: odg.code === 200 || odg.replay, oporavljen: false };
  }
  if (odg.code === 0 || odg.code >= 500) {
    var provjera = fiskalZahtjev_('get', '/racun?vanjskaReferenca=' + encodeURIComponent(payload.vanjskaReferenca));
    if (provjera.code === 200 && provjera.json && provjera.json.id) {
      return { racun: provjera.json, ponovljen: true, oporavljen: true };
    }
  }
  if (odg.code === 409 && odg.json && odg.json.racunId) {
    throw new Error(fiskalPorukaGreske_(odg) + '\n\nZa ovaj redak već postoji račun s DRUKČIJIM podacima ' +
      '(npr. promijenjena Uplata ili ime nakon izdavanja). Ne izdajem novi. ' +
      'Ispravak ide stornom postojećeg računa.');
  }
  throw new Error(fiskalPorukaGreske_(odg));
}

function fiskalStatusRacuna_(racun) {
  if (racun.fiskalizacija && racun.fiskalizacija.status === 'ceka_jir') return FISKAL_STATUS_.CEKA_JIR;
  return FISKAL_STATUS_.IZDAN;
}

/** Tekst za stupac Fiskal Račun: "1/2/1 · JIR 1a2b3c4d…" */
function fiskalOpisRacuna_(racun) {
  var t = racun.brojRacuna || ('id ' + racun.id);
  if (racun.jir) t += ' · JIR ' + String(racun.jir).slice(0, 8) + '…';
  else if (racun.tip === 'fiskalni_b2c') t += ' · čeka JIR';
  return t;
}

/** Link na račun u tenant dashboardu Fiskala. PDF API traži Bearer, pa javnog linka nema. */
function fiskalDashboardUrl_(id) {
  var base = CONFIG.FISKAL.DASHBOARD_URL || fiskalOkolina_().baseUrl.replace(/\/api\/v1$/, '');
  return base + '/app/dashboard/racun?id=' + id;
}

// ============================================================================
// SHEET
// ============================================================================

function fiskalStupac_(sheet, naziv) {
  var headers = getHeaders(sheet);
  var c = findColumnIndex(headers, naziv);
  if (c !== -1) return c;
  c = sheet.getLastColumn() + 1;
  sheet.getRange(1, c).setValue(naziv);
  return c;
}

function fiskalProcitaj_(sheet, row, naziv) {
  var c = findColumnIndex(getHeaders(sheet), naziv);
  return c === -1 ? '' : sheet.getRange(row, c).getValue();
}

function fiskalZapisiLink_(sheet, row, naziv, tekst, url) {
  var c = fiskalStupac_(sheet, naziv);
  sheet.getRange(row, c).setRichTextValue(
    SpreadsheetApp.newRichTextValue().setText(tekst).setLinkUrl(url).build());
}

function fiskalZapisiRacun_(sheet, row, racun) {
  var status = fiskalStatusRacuna_(racun);
  var sc = fiskalStupac_(sheet, FISKAL_STUPCI_.STATUS);
  sheet.getRange(row, sc).setValue(status)
    .setBackground(status === FISKAL_STATUS_.IZDAN ? '#d9ead3' : '#fff2cc');
  sheet.getRange(row, fiskalStupac_(sheet, FISKAL_STUPCI_.VRIJEME)).setValue(new Date());
  fiskalZapisiLink_(sheet, row, FISKAL_STUPCI_.RACUN, fiskalOpisRacuna_(racun), fiskalDashboardUrl_(racun.id));
  sheet.getRange(row, fiskalStupac_(sheet, FISKAL_STUPCI_.ID)).setValue(racun.id);
}

function fiskalZapisiGresku_(sheet, row, poruka) {
  var sc = fiskalStupac_(sheet, FISKAL_STUPCI_.STATUS);
  sheet.getRange(row, sc).setValue(FISKAL_STATUS_.GRESKA + ': ' + String(poruka).slice(0, 500)).setBackground('#f4cccc');
  sheet.getRange(row, fiskalStupac_(sheet, FISKAL_STUPCI_.VRIJEME)).setValue(new Date());
}

/**
 * Izdaj dokument za redak. Redak koji već ima Fiskal ID se NE šalje ponovno
 * (za ispravak: storno).
 * @returns {{racun:Object, ponovljen:boolean, oporavljen:boolean, email?:Object}}
 */
function izdajFiskalniZaRedak_(row, suppressDialogs, invoiceTypeOverride) {
  var ui = SpreadsheetApp.getUi();
  var sheet = getRadniSheet_();
  var headers = getHeaders(sheet);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    var okolina = fiskalOkolina_();
    fiskalKljuc_();

    var postojeci = fiskalProcitaj_(sheet, row, FISKAL_STUPCI_.ID);
    if (postojeci) {
      throw new Error('Redak već ima račun (Fiskal ID ' + postojeci + ', ' +
        fiskalProcitaj_(sheet, row, FISKAL_STUPCI_.RACUN) + '). Novi se ne izdaje — za ispravak koristi storno.');
    }

    ss.toast('Izdajem račun (' + okolina.naziv.toUpperCase() + ')…', 'Fiskal', -1);
    var rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
    var payload = buildFiskalPayload_(headers, rowData, invoiceTypeOverride);
    var v = validateFiskalPayload_(payload);
    if (!v.valid) throw new Error(v.error);

    var ishod = sendToFiskal_(payload);
    fiskalZapisiRacun_(sheet, row, ishod.racun);
    uncheckActionCheckbox(sheet, row, headers);

    if (CONFIG.FISKAL.AUTO_EMAIL && ishod.racun.status !== 'nacrt' && !ishod.racun.poslanoEmail) {
      ishod.email = fiskalPosaljiEmailZaRedak_(sheet, row, ishod.racun.id);
    }

    var naslov = '✅ ' + fiskalOpisRacuna_(ishod.racun) + (ishod.ponovljen ? ' (već izdan — isti račun)' : '');
    if (!suppressDialogs) {
      ui.alert(naslov,
        (ishod.oporavljen ? 'Fiskal nije odgovorio na vrijeme, ali račun je pronađen po referenci.\n\n' : '') +
        (fiskalStatusRacuna_(ishod.racun) === FISKAL_STATUS_.CEKA_JIR
          ? 'Račun je izdan (ima broj i ZKI), CIS još nije vratio JIR. Fiskal ga dovršava sam ' +
            '(svakih 15 min) — NE izdavati ponovno. Izbornik → 🔄 Osvježi status.\n\n'
          : '') +
        'Okolina: ' + fiskalOznakaOkoline_(okolina) +
        (ishod.email ? '\nE-mail: ' + ishod.email.poruka : ''),
        ui.ButtonSet.OK);
    }
    ss.toast(naslov, 'Fiskal', 5);
    return ishod;
  } catch (e) {
    Logger.log('❌ Redak ' + row + ': ' + e.message);
    // Redak s već izdanim računom zadržava svoj status — greška samo u dijalogu
    if (!fiskalProcitaj_(sheet, row, FISKAL_STUPCI_.ID)) fiskalZapisiGresku_(sheet, row, e.message);
    uncheckActionCheckbox(sheet, row, headers);
    if (!suppressDialogs) ui.alert('❌ Redak ' + row, e.message, ui.ButtonSet.OK);
    throw e;
  }
}

/**
 * Bulk: svi redci s valjanom Uplatom koji još nemaju Fiskal ID.
 * Staje nakon ~4,5 min; ponovno pokretanje nastavlja (izdani se preskaču,
 * a idempotencija pokriva redak koji je prekinut usred zapisa).
 */
function fiskalBulk() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getRadniSheet_();
  var okolina;
  try { okolina = fiskalOkolina_(); fiskalKljuc_(); }
  catch (e) { ui.alert('❌', e.message, ui.ButtonSet.OK); return; }

  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { ui.alert('Nema redaka.'); return; }
  var sve = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var cPay = findColumnIndex(headers, CONFIG.COLUMNS.PAYMENT) - 1;
  var cId = findColumnIndex(headers, FISKAL_STUPCI_.ID) - 1;
  var cName = findColumnIndex(headers, CONFIG.COLUMNS.NAME) - 1;
  if (cPay < 0) { ui.alert('Nema stupca "' + CONFIG.COLUMNS.PAYMENT + '".'); return; }

  var redci = [], bezUplate = 0, iznos = 0, vecIzdano = 0;
  for (var i = 0; i < sve.length; i++) {
    if (cId >= 0 && sve[i][cId]) { vecIzdano++; continue; }
    if (!sve[i][cName] && !sve[i][cPay]) continue; // prazan redak
    var pv = validatePaymentAmount(sve[i][cPay]);
    if (!pv.valid) { bezUplate++; continue; }
    redci.push(i + 2);
    iznos += pv.amount;
  }

  if (!redci.length) {
    ui.alert('Nema što izdati', 'Već izdano: ' + vecIzdano + '\nBez valjane uplate: ' + bezUplate, ui.ButtonSet.OK);
    return;
  }

  var potvrda = ui.alert('Bulk — ' + redci.length + ' računa · ' + okolina.naziv.toUpperCase(),
    'Okolina: ' + fiskalOznakaOkoline_(okolina) + '\n\n' +
    '🧾 Izdat će se: ' + redci.length + ' (' + CONFIG.DEFAULT_INVOICE_TYPE + '), ukupno ' + roundTwo(iznos) + ' ' + CONFIG.DEFAULT_CURRENCY + '\n' +
    '✔️ Već izdano (preskačem): ' + vecIzdano + '\n' +
    'ℹ️ Bez valjane uplate (preskačem): ' + bezUplate + '\n\n' +
    'Izdaju se SVI redci s iznosom u stupcu "' + CONFIG.COLUMNS.PAYMENT + '" koji još nemaju račun.\n' +
    'Nakon ~4,5 min staje — tada pokreni ponovno za nastavak.',
    ui.ButtonSet.YES_NO);
  if (potvrda !== ui.Button.YES) return;

  var start = Date.now(), ok = 0, greske = [], obradeno = 0;
  for (var j = 0; j < redci.length; j++) {
    if (Date.now() - start > FISKAL_BULK_BUDZET_MS_) break;
    SpreadsheetApp.getActiveSpreadsheet().toast((j + 1) + '/' + redci.length, 'Fiskal bulk', -1);
    try {
      izdajFiskalniZaRedak_(redci[j], true, CONFIG.DEFAULT_INVOICE_TYPE);
      ok++;
    } catch (e) {
      greske.push('Redak ' + redci[j] + ': ' + e.message.split('\n')[0]);
    }
    obradeno++;
  }

  var ostalo = redci.length - obradeno;
  ui.alert(ostalo ? '⏸️ Bulk prekinut (vremenski limit)' : 'Bulk završen',
    '✅ Izdano: ' + ok + '\n❌ Greške: ' + greske.length +
    (ostalo ? '\n⏭️ Preostalo: ' + ostalo + ' — pokreni Bulk ponovno za nastavak.' : '') +
    (greske.length ? '\n\n' + greske.slice(0, 15).join('\n') + (greske.length > 15 ? '\n…' : '') : '') +
    '\n\nDetalji u stupcu "' + FISKAL_STUPCI_.STATUS + '".',
    ui.ButtonSet.OK);
}

// ============================================================================
// E-MAIL, STATUS, STORNO (akcije nad odabranim retkom)
// ============================================================================

function fiskalOdabraniRedak_() {
  var sheet = getRadniSheet_();
  var active = SpreadsheetApp.getActiveSheet();
  if (active.getName() !== sheet.getName()) throw new Error('Odaberi redak na tabu "' + sheet.getName() + '".');
  var row = active.getActiveRange().getRow();
  if (row <= 1) throw new Error('Odaberi redak s podacima (ne zaglavlje).');
  var id = fiskalProcitaj_(sheet, row, FISKAL_STUPCI_.ID);
  if (!id) throw new Error('Redak ' + row + ' nema izdan račun (stupac "' + FISKAL_STUPCI_.ID + '" je prazan).');
  return { sheet: sheet, row: row, id: id };
}

/** POST /racun/:id/posalji; neuspjeh se zapisuje, ne baca. */
function fiskalPosaljiEmailZaRedak_(sheet, row, id) {
  var odg = fiskalZahtjev_('post', '/racun/' + id + '/posalji', {});
  var c = fiskalStupac_(sheet, FISKAL_STUPCI_.EMAIL);
  var rez;
  if (odg.code === 200 && odg.json && odg.json.ok) {
    rez = { ok: true, poruka: 'poslano na ' + odg.json.poslanoNa };
  } else {
    rez = { ok: false, poruka: 'NIJE poslano — ' + fiskalPorukaGreske_(odg).split('\n')[0] };
  }
  sheet.getRange(row, c).setValue(rez.poruka + ' (' + Utilities.formatDate(new Date(), 'Europe/Zagreb', 'd.M.yyyy. HH:mm') + ')')
    .setBackground(rez.ok ? null : '#f4cccc');
  return rez;
}

function fiskalPosaljiEmail() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = fiskalOdabraniRedak_();
    var vec = fiskalProcitaj_(r.sheet, r.row, FISKAL_STUPCI_.EMAIL);
    if (vec && String(vec).indexOf('poslano na') === 0 &&
        ui.alert('Već poslano', vec + '\n\nPoslati ponovno?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    var rez = fiskalPosaljiEmailZaRedak_(r.sheet, r.row, r.id);
    ui.alert(rez.ok ? '✅ E-mail' : '❌ E-mail', rez.poruka, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('❌', e.message, ui.ButtonSet.OK);
  }
}

/** Osvježi sve retke „čeka JIR” iz GET /racun/:id. */
function fiskalOsvjeziStatuse() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getRadniSheet_();
  var headers = getHeaders(sheet);
  var cS = findColumnIndex(headers, FISKAL_STUPCI_.STATUS), cId = findColumnIndex(headers, FISKAL_STUPCI_.ID);
  if (cS === -1 || cId === -1 || sheet.getLastRow() <= 1) { ui.alert('Nema izdanih računa.'); return; }
  var n = sheet.getLastRow() - 1;
  var st = sheet.getRange(2, cS, n, 1).getValues(), ids = sheet.getRange(2, cId, n, 1).getValues();
  var provjereno = 0, dovrseno = 0, greske = [];
  for (var i = 0; i < n; i++) {
    if (st[i][0] !== FISKAL_STATUS_.CEKA_JIR || !ids[i][0]) continue;
    provjereno++;
    var odg = fiskalZahtjev_('get', '/racun/' + ids[i][0]);
    if (odg.code !== 200) { greske.push('Redak ' + (i + 2) + ': ' + fiskalPorukaGreske_(odg).split('\n')[0]); continue; }
    fiskalZapisiRacun_(sheet, i + 2, odg.json);
    if (odg.json.jir) dovrseno++;
  }
  ui.alert('🔄 Status', 'Čekalo JIR: ' + provjereno + '\nSada s JIR-om: ' + dovrseno +
    (greske.length ? '\n\n' + greske.join('\n') : ''), ui.ButtonSet.OK);
}

function fiskalStornoCijeli() { fiskalStorno_(1); }
function fiskalStorno50() { fiskalStorno_(0.5); }

/**
 * Storno: cijeli (povrat 100 %) ili pola (povrat 50 %).
 * POST /racun/:id/storno — novi fiskalni račun s negativnim iznosom.
 * Idempotentno: referenca <original>-storno / -storno50.
 */
function fiskalStorno_(udio) {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = fiskalOdabraniRedak_();
    var okolina = fiskalOkolina_();
    var vec = fiskalProcitaj_(r.sheet, r.row, FISKAL_STUPCI_.STORNO);
    if (vec) throw new Error('Redak već ima storno: ' + vec);

    var orig = fiskalZahtjev_('get', '/racun/' + r.id);
    if (orig.code !== 200) throw new Error(fiskalPorukaGreske_(orig));
    var racun = orig.json;
    var opis = udio === 1 ? 'CIJELI (100 %)' : 'DJELOMIČNI (50 %)';
    var iznos = roundTwo(racun.iznosi.iznosSPdv * udio);

    if (ui.alert('Storno ' + opis + ' — ' + racun.brojRacuna,
        'Okolina: ' + fiskalOznakaOkoline_(okolina) + '\n\n' +
        'Kupac: ' + (racun.kupac ? racun.kupac.naziv : '?') + '\n' +
        'Original: ' + racun.brojRacuna + ', ' + racun.iznosi.iznosSPdv + ' ' + racun.valuta + '\n' +
        'Storno: −' + iznos + ' ' + racun.valuta + '\n\n' +
        'Izdaje se novi fiskalni račun s negativnim iznosom (ide u CIS). Nastaviti?',
        ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var tijelo = {
      vanjskaReferenca: racun.vanjskaReferenca + (udio === 1 ? '-storno' : '-storno50'),
      napomena: udio === 1
        ? 'Storno računa ' + racun.brojRacuna + ' — povrat kotizacije 100 % / Full refund'
        : 'Djelomični storno računa ' + racun.brojRacuna + ' — povrat 50 % kotizacije / 50% refund'
    };
    if (udio !== 1) tijelo.stavke = [{ redak: 1, kolicina: String(udio) }];

    var odg = fiskalZahtjev_('post', '/racun/' + r.id + '/storno', tijelo, tijelo.vanjskaReferenca);
    if (odg.code !== 201 && odg.code !== 200) throw new Error(fiskalPorukaGreske_(odg));
    var s = odg.json;
    fiskalZapisiLink_(r.sheet, r.row, FISKAL_STUPCI_.STORNO,
      (udio === 1 ? 'storno 100 %: ' : 'storno 50 %: ') + fiskalOpisRacuna_(s), fiskalDashboardUrl_(s.id));
    ui.alert('✅ Storno ' + s.brojRacuna, fiskalOpisRacuna_(s) + ', ' + s.iznosi.iznosSPdv + ' ' + s.valuta, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('❌ Storno', e.message, ui.ButtonSet.OK);
  }
}
