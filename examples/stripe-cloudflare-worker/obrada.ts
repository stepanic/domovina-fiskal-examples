/**
 * Logika webhooka, odvojena od Hono/Stripe SDK-a da se može testirati.
 *
 *   checkout.session.completed (payment_status 'paid')  ┐
 *   checkout.session.async_payment_succeeded            ┴→ izdaj fiskalni račun
 *   charge.refunded (cijeli iznos)                       → storno računa
 *
 * Povratna vrijednost određuje HTTP odgovor Stripeu: `ponovi: true` → 500,
 * pa Stripe ponavlja webhook (do 3 dana). To je sigurno jer je izdavanje
 * idempotentno po payment_intentu.
 */
import { FiskalGreska, type FiskalKlijent, type Racun } from './fiskal.ts';
import {
  paymentIntentId,
  provjeriIznos,
  racunIzCheckoutSessiona,
  referencaZaPlacanje,
  type PostavkeIzdavatelja,
  type StripeLineItem,
  type StripeSession,
} from './stripe-u-racun.ts';

/** Minimalni oblik Stripe eventa (`Stripe.Event`). */
export interface StripeDogadaj {
  id: string;
  type: string;
  data: { object: any };
}

export interface Ovisnosti {
  fiskal: FiskalKlijent;
  postavke: PostavkeIzdavatelja;
  /** `stripe.checkout.sessions.listLineItems(id, { limit: 100 })` → `.data` */
  stavkeSessiona: (sessionId: string) => Promise<StripeLineItem[]>;
  /** Spremi vezu narudžba ↔ račun u svoju bazu (npr. D1). */
  spremiRacun: (paymentIntentId: string, racun: Racun) => Promise<void>;
  /** Poslati PDF kupcu odmah nakon izdavanja? */
  posaljiEmail?: boolean;
  log?: (poruka: string, podaci?: unknown) => void;
}

export interface Ishod {
  ponovi: boolean;
  poruka: string;
}

export async function obradiDogadaj(e: StripeDogadaj, d: Ovisnosti): Promise<Ishod> {
  const log = d.log ?? ((p, x) => console.log(p, x ?? ''));
  try {
    switch (e.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const s = e.data.object as StripeSession & { payment_status?: string };
        // Odgođena plaćanja (SEPA i sl.) stižu kao completed + 'unpaid', a račun
        // se izdaje tek na async_payment_succeeded.
        if (s.payment_status && s.payment_status !== 'paid') return { ponovi: false, poruka: `session ${s.id}: ${s.payment_status}, račun kasnije` };
        return await izdajZaSession(s, d, log);
      }
      case 'charge.refunded':
        return await stornirajZaPovrat(e.data.object, d, log);
      default:
        return { ponovi: false, poruka: `ignoriram ${e.type}` };
    }
  } catch (err) {
    if (err instanceof FiskalGreska) {
      // 4xx (validacija, 409 drukčiji sadržaj) ponavljanje ne popravlja — zabilježi
      // i javi čovjeku; 5xx / mreža → neka Stripe ponovi.
      log(`Fiskal ${err.status}: ${err.message}`, err.detalji);
      return { ponovi: err.privremena, poruka: err.message };
    }
    throw err;
  }
}

async function izdajZaSession(s: StripeSession, d: Ovisnosti, log: NonNullable<Ovisnosti['log']>): Promise<Ishod> {
  const pi = paymentIntentId(s);
  const zahtjev = racunIzCheckoutSessiona(s, await d.stavkeSessiona(s.id), d.postavke);
  const { racun, ponovljen } = await d.fiskal.izdaj(zahtjev);

  if (!provjeriIznos(racun.iznosi.iznosSPdv, s.amount_total)) {
    log(`UPOZORENJE: račun ${racun.brojRacuna} = ${racun.iznosi.iznosSPdv}, Stripe naplatio ${s.amount_total} centi`);
  }
  await d.spremiRacun(pi, racun);

  const cekaJir = racun.fiskalizacija?.status === 'ceka_jir';
  if (d.posaljiEmail && !racun.poslanoEmail) {
    if (cekaJir) {
      // Fiskal ne šalje račun bez JIR-a (409 NEMA_JIR). JIR dovršava cron na
      // Fiskalu (svakih 15 min) — pošalji iz svog crona kad GET /racun/:id vrati jir.
      log(`račun ${racun.brojRacuna} čeka JIR — e-mail kasnije`);
    } else {
      try {
        await d.fiskal.posalji(racun.id);
      } catch (err) {
        // Račun je izdan; neuspjeh e-maila ne smije pokrenuti ponovno izdavanje.
        log(`e-mail za ${racun.brojRacuna} nije poslan: ${(err as Error).message}`);
      }
    }
  }
  return { ponovi: false, poruka: `${ponovljen ? 'već izdan' : 'izdan'} ${racun.brojRacuna}${cekaJir ? ' (čeka JIR)' : ''}` };
}

async function stornirajZaPovrat(
  charge: { id: string; payment_intent: string | { id: string } | null; amount: number; amount_refunded: number },
  d: Ovisnosti,
  log: NonNullable<Ovisnosti['log']>,
): Promise<Ishod> {
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return { ponovi: false, poruka: `charge ${charge.id} bez payment_intenta` };
  const ref = referencaZaPlacanje(pi);
  const original = await d.fiskal.racunPoReferenci(ref);
  if (!original) return { ponovi: false, poruka: `nema računa za ${ref} — ništa za stornirati` };

  if (charge.amount_refunded < charge.amount) {
    // Djelomični povrat: Fiskal storno ide po retcima i količinama
    // (`stavke: [{ redak, kolicina }]`). Koji dio odgovara povratu zna samo
    // tvoja domena (koja ulaznica je vraćena), pa to ovdje ne pogađamo.
    log(`djelomični povrat ${charge.amount_refunded}/${charge.amount} za ${original.brojRacuna} — storno ručno ili po svojoj logici`);
    return { ponovi: false, poruka: 'djelomični povrat — bez automatskog storna' };
  }
  const storno = await d.fiskal.storno(original.id, {
    vanjskaReferenca: `${ref}-storno`,
    napomena: `Storno računa ${original.brojRacuna} — povrat novca (Stripe ${charge.id})`,
  });
  return { ponovi: false, poruka: `storniran ${original.brojRacuna} → ${storno.brojRacuna}` };
}
