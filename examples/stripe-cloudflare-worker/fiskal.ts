/**
 * Minimalni klijent za Domovina Fiskal API (v1), bez ovisnosti: samo `fetch`.
 * Radi u Cloudflare Workeru, Node 18+, Deno i Bunu.
 *
 * Tri pravila koja klijent mora poštovati (sve ostalo je detalj):
 *  1. Svaki POST koji izdaje dokument nosi `vanjskaReferenca` (i isto u
 *     zaglavlju `Idempotency-Key`). Ponovljeni zahtjev s istom referencom i
 *     istim sadržajem vrati ISTI račun (200 + `Idempotent-Replay: true`).
 *  2. Ako odgovor ne stigne (mreža, timeout, 5xx), račun je možda ipak izdan:
 *     prvo `GET /racun?vanjskaReferenca=…`, tek onda javi grešku.
 *  3. `fiskalizacija.status === 'ceka_jir'` NIJE greška: račun je izdan (ima
 *     broj i ZKI), Fiskal sam dovršava JIR. Ne izdavati novi račun.
 */

export type TipDokumenta = 'PONUDA' | 'PREDRACUN' | 'RACUN' | 'FISKALNI_B2C' | 'ERACUN_B2B' | 'ERACUN_B2G';
export type NacinPlacanja = 'GOTOVINA' | 'KARTICA' | 'TRANSAKCIJSKI' | 'OSTALO';
type Iznos = string | number;

export interface Kupac {
  naziv: string;
  tip?: 'fizicka' | 'pravna' | 'drzava';
  email?: string;
  oib?: string;
  adresa?: { ulica?: string; grad?: string; postanskiBroj?: string; drzava?: string };
}

export interface Stavka {
  naziv: string;
  opis?: string;
  kolicina?: Iznos;
  jedinicaMjere?: string;   // UN/ECE Rec 20, npr. 'H87' komad, 'C62' jedinica
  netoCijena: Iznos;        // cijena BEZ PDV-a po jedinici, u valuti računa
  pdvStopa?: Iznos;         // 25 | 13 | 5 | 0; tenant izvan PDV-a: uvijek 0
  kpd?: string;
}

export interface RacunZahtjev {
  tip: TipDokumenta;
  poslovniProstor: string;
  naplatniUredaj: string;
  operaterOib?: string;     // obavezan za FISKALNI_B2C
  nacinPlacanja?: NacinPlacanja;
  valuta?: string;
  datumIsporuke?: string;   // YYYY-MM-DD
  uvjeti?: string;          // ≤4000, na PDF-u
  napomena?: string;        // ≤2000, na PDF-u
  internaBiljeska?: string; // ≤2000, NIJE na PDF-u
  vanjskaReferenca: string; // ≤100, [\w./:-]
  kupac?: Kupac;
  stavke: Stavka[];
}

export interface Racun {
  id: number;
  vanjskaReferenca: string | null;
  brojRacuna: string | null;          // npr. "12/1/1"
  tip: string;                        // 'fiskalni_b2c', 'racun', …
  status: string;
  datumVrijeme: string;
  valuta: string;
  iznosi: { neto: Iznos; iznosBezPdv: Iznos; pdv: Iznos; iznosSPdv: Iznos; dospijevaZaPlacanje: Iznos };
  pdf: string;                        // "/api/v1/racun/{id}/pdf" — traži Bearer
  poslanoEmail: { kada: string; na: string } | null;
  zki: string | null;
  jir: string | null;
  fiskalniQr: string | null;
  fiskalizacija?: { status: 'fiskaliziran' | 'ceka_jir'; greska?: string | null; automatskiRetry?: boolean };
  stornoZaId?: number | null;
}

export interface FiskalOpcije {
  /** npr. https://fiskal-test.domovina.ai/api/v1 (TEST) ili https://fiskal.domovina.ai/api/v1 (PROD) */
  baseUrl: string;
  /** `dfk_…` ključ tenanta — iz secreta, nikad u kodu */
  apiKljuc: string;
  fetch?: typeof fetch;
}

/** Greška API-ja s HTTP kodom i detaljima validacije. `status` 0 = nema odgovora. */
export class FiskalGreska extends Error {
  status: number;
  detalji: { polje: string; poruka: string }[];
  racunId: number | undefined;
  constructor(status: number, poruka: string, detalji: { polje: string; poruka: string }[] = [], racunId?: number) {
    super(poruka);
    this.name = 'FiskalGreska';
    this.status = status;
    this.detalji = detalji;
    this.racunId = racunId;
  }
  /** Vrijedi ponoviti kasnije (mreža, 5xx); 4xx se ponavljanjem ne popravlja. */
  get privremena(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface IzdavanjeRezultat {
  racun: Racun;
  /** true = račun je postojao od ranije (replay ili oporavak nakon timeouta) */
  ponovljen: boolean;
}

export function fiskalKlijent(o: FiskalOpcije) {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');

  async function zahtjev(metoda: string, putanja: string, tijelo?: unknown, idempotencyKey?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${o.apiKljuc}`, Accept: 'application/json' };
    if (tijelo !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res: Response;
    try {
      res = await f(base + putanja, { method: metoda, headers, body: tijelo === undefined ? undefined : JSON.stringify(tijelo) });
    } catch (e) {
      throw new FiskalGreska(0, `Fiskal nije odgovorio: ${(e as Error).message}`);
    }
    const tekst = await res.text();
    let json: any = null;
    try { json = tekst ? JSON.parse(tekst) : null; } catch { /* nije JSON */ }
    if (!res.ok) {
      throw new FiskalGreska(res.status, json?.greska ?? `HTTP ${res.status}`, json?.detalji ?? [], json?.racunId);
    }
    return { status: res.status, json, replay: res.headers.get('Idempotent-Replay') === 'true' };
  }

  /** Račun po vanjskoj referenci ili null ako ne postoji. */
  async function racunPoReferenci(vanjskaReferenca: string): Promise<Racun | null> {
    try {
      return (await zahtjev('GET', `/racun?vanjskaReferenca=${encodeURIComponent(vanjskaReferenca)}`)).json as Racun;
    } catch (e) {
      if (e instanceof FiskalGreska && e.status === 404) return null;
      throw e;
    }
  }

  return {
    /**
     * Izdaj dokument. Sigurno za ponavljanje s istom `vanjskaReferenca`.
     * 409 (ista referenca, drukčiji sadržaj) baca FiskalGreska s `racunId`:
     * to znači da je račun već izdan s drugim podacima — ispravak ide stornom.
     */
    async izdaj(racun: RacunZahtjev): Promise<IzdavanjeRezultat> {
      try {
        const r = await zahtjev('POST', '/racun', racun, racun.vanjskaReferenca);
        return { racun: r.json as Racun, ponovljen: r.status === 200 || r.replay };
      } catch (e) {
        if (e instanceof FiskalGreska && e.privremena) {
          const postojeci = await racunPoReferenci(racun.vanjskaReferenca).catch(() => null);
          if (postojeci) return { racun: postojeci, ponovljen: true };
        }
        throw e;
      }
    },

    racunPoReferenci,

    async racun(id: number): Promise<Racun> {
      return (await zahtjev('GET', `/racun/${id}`)).json as Racun;
    },

    /**
     * Pošalji PDF e-mailom (default na `kupac.email`). Dok fiskalni račun čeka
     * JIR, Fiskal odbija slanje s 409 (`kod: 'NEMA_JIR'`) — pokušaj kasnije.
     */
    async posalji(id: number, na?: string): Promise<unknown> {
      return (await zahtjev('POST', `/racun/${id}/posalji`, na ? { na } : {})).json;
    },

    /**
     * Storno fiskalnog računa (novi račun s negativnim iznosom). Bez `stavke`
     * stornira cijeli račun; `stavke: [{ redak: 1, kolicina: '0.5' }]` = pola prvog retka.
     */
    async storno(id: number, opcije: { vanjskaReferenca: string; napomena?: string; operaterOib?: string; stavke?: { redak: number; kolicina?: Iznos }[] }): Promise<Racun> {
      return (await zahtjev('POST', `/racun/${id}/storno`, opcije, opcije.vanjskaReferenca)).json as Racun;
    },

    /** PDF (Bearer) — npr. za proxy na vlastitoj stranici narudžbe. */
    async pdf(id: number): Promise<ArrayBuffer> {
      const res = await f(`${base}/racun/${id}/pdf`, { headers: { Authorization: `Bearer ${o.apiKljuc}` } });
      if (!res.ok) throw new FiskalGreska(res.status, `PDF HTTP ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

export type FiskalKlijent = ReturnType<typeof fiskalKlijent>;
