/**
 * Stripe Checkout Session → tijelo `POST /racun` za Domovina Fiskal.
 * Čista funkcija (bez mreže), pa je lako testirati. Tipovi su minimalni
 * podskup Stripeovih, da modul ne ovisi o paketu `stripe`.
 */
import type { RacunZahtjev, Stavka } from './fiskal.ts';

/** Ono što nam treba iz `Stripe.Checkout.Session`. */
export interface StripeSession {
  id: string;
  payment_intent: string | { id: string } | null;
  currency: string | null;
  amount_total: number | null;
  customer_details: {
    name: string | null;
    email: string | null;
    address: { city: string | null; country: string | null; line1: string | null; postal_code: string | null } | null;
  } | null;
  metadata?: Record<string, string> | null;
}

/** Ono što nam treba iz `Stripe.LineItem` (`stripe.checkout.sessions.listLineItems`). */
export interface StripeLineItem {
  description: string | null;
  quantity: number | null;
  amount_total: number; // u centima, S PDV-om, nakon popusta
}

export interface PostavkeIzdavatelja {
  poslovniProstor: string;
  naplatniUredaj: string;
  operaterOib: string;
  /** 0 ako je izdavatelj izvan sustava PDV-a; inače stopa u postocima (25, 13, 5). */
  pdvStopa: number;
  jedinicaMjere?: string;
  /** Datum isporuke (npr. datum događaja), YYYY-MM-DD. Bez njega Fiskal uzima datum izdavanja. */
  datumIsporuke?: string;
  uvjeti?: string;
}

/**
 * Stabilan ključ idempotencije: isti za `checkout.session.completed`,
 * `checkout.session.async_payment_succeeded` i `charge.refunded` (preko
 * payment_intenta), pa ponovljeni webhook nikad ne izda drugi račun.
 */
export function referencaZaPlacanje(paymentIntentId: string): string {
  return `stripe-${paymentIntentId}`;
}

export function paymentIntentId(s: Pick<StripeSession, 'id' | 'payment_intent'>): string {
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
  if (!pi) throw new Error(`Checkout Session ${s.id} nema payment_intent (subscription/setup mode nije pokriven primjerom)`);
  return pi;
}

/** Centi → "12.34" bez float grešaka. */
export function centiUIznos(centi: number): string {
  const znak = centi < 0 ? '-' : '';
  const a = Math.abs(Math.round(centi));
  return `${znak}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * Bruto (s PDV-om) u centima → neto u centima. Fiskal prima neto cijenu i sam
 * računa PDV, pa za stopu > 0 provjeri da se `iznosi.iznosSPdv` u odgovoru
 * poklapa s iznosom naplaćenim na Stripeu (vidi `provjeriIznos`).
 */
export function netoIzBruto(brutoCenti: number, pdvStopa: number): number {
  return pdvStopa ? Math.round((brutoCenti * 100) / (100 + pdvStopa)) : brutoCenti;
}

function stavkaIzLineItema(li: StripeLineItem, p: PostavkeIzdavatelja): Stavka {
  const kolicina = li.quantity ?? 1;
  const naziv = (li.description || 'Stavka').slice(0, 500);
  // Ako se ukupni iznos retka ne dijeli točno po komadu (popust na cijelu
  // narudžbu), izdaj jedan redak „N × naziv” s ukupnim iznosom — inače bi
  // zbroj na računu odstupao od naplaćenog za cent.
  const poKomadu = li.amount_total % kolicina === 0;
  return {
    naziv: poKomadu ? naziv : `${kolicina} × ${naziv}`.slice(0, 500),
    kolicina: poKomadu ? kolicina : 1,
    jedinicaMjere: p.jedinicaMjere ?? 'H87',
    netoCijena: centiUIznos(netoIzBruto(poKomadu ? li.amount_total / kolicina : li.amount_total, p.pdvStopa)),
    pdvStopa: p.pdvStopa,
  };
}

export function racunIzCheckoutSessiona(s: StripeSession, stavke: StripeLineItem[], p: PostavkeIzdavatelja): RacunZahtjev {
  if (!stavke.length) throw new Error(`Checkout Session ${s.id} nema stavki`);
  const kd = s.customer_details;
  const adresa = kd?.address;
  const racun: RacunZahtjev = {
    tip: 'FISKALNI_B2C',
    poslovniProstor: p.poslovniProstor,
    naplatniUredaj: p.naplatniUredaj,
    operaterOib: p.operaterOib,
    nacinPlacanja: 'KARTICA',
    valuta: (s.currency || 'eur').toUpperCase(),
    vanjskaReferenca: referencaZaPlacanje(paymentIntentId(s)),
    internaBiljeska: `Stripe ${s.id}`,
    kupac: {
      naziv: (kd?.name || kd?.email || 'Kupac').trim().slice(0, 300),
      tip: 'fizicka',
      ...(kd?.email ? { email: kd.email.trim() } : {}),
      adresa: {
        drzava: (adresa?.country || 'HR').toUpperCase(),
        ...(adresa?.city ? { grad: adresa.city.trim().slice(0, 100) } : {}),
        ...(adresa?.line1 ? { ulica: adresa.line1.trim().slice(0, 200) } : {}),
        ...(adresa?.postal_code ? { postanskiBroj: adresa.postal_code.trim().slice(0, 16) } : {}),
      },
    },
    stavke: stavke.map((li) => stavkaIzLineItema(li, p)),
  };
  if (p.datumIsporuke) racun.datumIsporuke = p.datumIsporuke;
  if (p.uvjeti) racun.uvjeti = p.uvjeti;
  return racun;
}

/** Usporedi iznos računa s naplaćenim na Stripeu (u centima). */
export function provjeriIznos(iznosSPdv: string | number, stripeCenti: number | null): boolean {
  if (stripeCenti == null) return true;
  return Math.round(Number(iznosSPdv) * 100) === stripeCenti;
}
