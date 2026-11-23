/**
 * Event Configuration: Primjer konferencija 2027 (IZMIŠLJENI PRIMJER)
 *
 * Kopiraj ovaj folder u gas/events/<tvoj-slug>/ i promijeni sve što je
 * označeno s „PROMIJENI”. Izdavatelj, OIB i Sheet ID-evi ovdje su izmišljeni.
 *
 * Tok: Google Forms → Google Sheet → (klik na checkbox ili Bulk) →
 *      POST /api/v1/racun na Domovina Fiskal → JIR i link u retku Sheeta.
 *
 * Cijena se NE upisuje ovdje: iznos ide iz stupca „Uplata” (organizator ga
 * upiše kad vidi uplatu na računu), pa jedan Config pokriva sve tierove cijena.
 *
 * PROVIDER = DOMOVINA_FISKAL → koristi se blok FISKAL ispod; FIRA polja
 * (PAYMENT_GATEWAY_*, TERMS_DE, customerLocale…) se ne koriste.
 * API ključ NIJE ovdje — organizator ga upiše kroz izbornik u Sheetu i on
 * ostaje u Script Properties (FISKAL_API_KEY). Base URL se bira po ID-u
 * Sheeta iz okoline.json (TEST Sheet ↔ fiskal-test, PROD Sheet ↔ fiskal).
 */

var CONFIG = {
  PROVIDER: 'DOMOVINA_FISKAL',   // 'FIRA' | 'DOMOVINA_FISKAL'

  // ── Event (PROMIJENI) ───────────────────────────────────────────────────
  // Dvojezično jer Fiskal ne bira jezik po državi kupca (jedan PDF tekst).
  SERVICE_NAME: 'Registration fee Primjer konferencija 2027 / Kotizacija za Primjer konferenciju 2027 (12.-14.3.2027.)',
  DELIVERY_PLACE: 'Zagreb',
  CONFERENCE_DATE: '2027-03-12',   // → Fiskal datumIsporuke (YYYY-MM-DD)

  // ── Tip dokumenta (isti vokabular u Sheetu kao kod FIRA integracije) ────
  // 'PONUDA' | 'RAČUN' | 'FISKALNI_RAČUN'  → adapter mapira na
  // 'PONUDA' | 'RACUN' | 'FISKALNI_B2C'
  DEFAULT_INVOICE_TYPE: 'FISKALNI_RAČUN',

  DEFAULT_CURRENCY: 'EUR',
  // 'GOTOVINA' | 'TRANSAKCIJSKI' | 'KARTICA' (Fiskal ima i 'OSTALO')
  DEFAULT_PAYMENT_TYPE: 'TRANSAKCIJSKI',

  // ── PDV ─────────────────────────────────────────────────────────────────
  // Primjer: izdavatelj je izvan sustava PDV-a → pdvStopa 0; Fiskal sam
  // dodaje klauzulu čl. 90 st. 1. Izdavatelj u sustavu PDV-a: VAT_ENABLED true,
  // DEFAULT_TAX_RATE 0.25, a „Uplata” je tada NETO iznos.
  VAT_ENABLED: false,
  DEFAULT_TAX_RATE: 0,
  DEFAULT_KPD_CODE: '',

  // ── Domovina Fiskal (PROMIJENI — vrijednosti iz GET /api/v1/postavke) ───
  FISKAL: {
    POSLOVNI_PROSTOR: '1',           // oznaka poslovnog prostora tenanta
    NAPLATNI_UREDAJ: '1',            // oznaka naplatnog uređaja
    OPERATER_OIB: '12345678903',     // OIB operatera (izmišljen, ali s valjanom kontrolnom znamenkom)
    JEDINICA_MJERE: 'H87',           // UN/ECE Rec 20; 'H87' = komad
    // Idempotencija: <prefix>-<sha1(vremenska oznaka|email) prvih 16 hex>.
    // NE broj retka — redovi se smiju ručno premještati.
    REFERENCE_PREFIX: 'primjer27',
    // Nakon izdavanja odmah POST /racun/:id/posalji na kupčev e-mail. Račun koji
    // čeka JIR dobiva mail iz 🔄 Osvježi status kad CIS vrati JIR (jednom).
    AUTO_EMAIL: true,
    // Link u stupcu „Fiskal Račun”: <host>/app/dashboard/racun?id=<id>
    // (dashboard ulogiranog tenanta). Prazno = host iz okoline.
    DASHBOARD_URL: ''
  },

  // Uvjeti na PDF-u (jedan tekst, dvojezično). Klauzulu o PDV-u NE ponavljati.
  UVJETI:
    'This invoice has been paid — registration fee for Primjer konferencija 2027, 12-14 March 2027.\n' +
    'Račun je plaćen — kotizacija za Primjer konferenciju 2027, 12.-14. ožujka 2027.\n' +
    'Refund: 100% until 1 Mar 2027, 50% until 8 Mar 2027. / Povrat: 100% do 1.3.2027., 50% do 8.3.2027.',

  MAX_INTERNAL_NOTE_LENGTH: 250,
  DEFAULT_COUNTRY: 'HR',

  // Skripta radi SAMO na ovom tabu (ostali tabovi se ne diraju)
  SHEET_NAME: 'Odgovori iz obrasca 1',

  // ── Stupci — EXACT headeri iz tvog Sheeta (PROMIJENI) ───────────────────
  // Google Forms zna dodati razmak ili \n na kraj headera — kopiraj ih točno.
  // Fiskal stupci (Fiskal Status/Vrijeme/Račun/ID/E-mail/Storno) dodaje skripta.
  // OIB, Payment Type i AKCIJA_RACUN dodaje izbornik „Dodaj stupce”.
  // TIMESTAMP + EMAIL čine ključ idempotencije (vanjskaReferenca).
  COLUMNS: {
    TIMESTAMP: 'Vremenska oznaka',
    EMAIL: 'E-adresa',
    PAYMENT: 'Uplata',
    NAME: 'Name and surname (Ime i prezime)',
    GENDER: 'Gender (Spol)',
    CITY_COUNTRY: 'City and Country (Mjesto i država)',
    PHONE: 'Phone number (Kontakt broj)',
    YEAR_OF_BIRTH: 'Year of birth (Godina rođenja)',
    OCCUPATION: 'Occupation (Zanimanje)',
    OIB: 'OIB',
    PAYMENT_TYPE: 'Payment Type',
    INVOICE_TYPE: 'Tip dokumenta',   // Fiskal: ne koristi se (uvijek DEFAULT_INVOICE_TYPE)
    ACTION: 'AKCIJA_RACUN'
  }
};
