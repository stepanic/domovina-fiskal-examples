/**
 * Cloudflare Worker (Hono): Stripe webhook → fiskalni račun u Domovina Fiskalu.
 *
 * Secreti (wrangler secret put …):
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, FISKAL_API_KEY
 * Varijable (wrangler.jsonc → vars):
 *   FISKAL_BASE_URL       https://fiskal-test.domovina.ai/api/v1 (TEST) | https://fiskal.domovina.ai/api/v1 (PROD)
 *   FISKAL_PROSTOR        oznaka poslovnog prostora (GET /postavke)
 *   FISKAL_UREDAJ         oznaka naplatnog uređaja
 *   FISKAL_OPERATER_OIB   OIB operatera
 *   FISKAL_PDV_STOPA      "0" ako je izdavatelj izvan sustava PDV-a, inače "25"/"13"/"5"
 *
 * Stripe Dashboard → Webhooks → endpoint `https://<worker>/stripe/webhook`, eventi:
 *   checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded
 */
import { Hono } from 'hono';
import Stripe from 'stripe';
import { fiskalKlijent } from './fiskal.ts';
import { obradiDogadaj } from './obrada.ts';

type Env = {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  FISKAL_API_KEY: string;
  FISKAL_BASE_URL: string;
  FISKAL_PROSTOR: string;
  FISKAL_UREDAJ: string;
  FISKAL_OPERATER_OIB: string;
  FISKAL_PDV_STOPA: string;
};

const app = new Hono<{ Bindings: Env }>();

app.post('/stripe/webhook', async (c) => {
  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  // Potpis se provjerava nad SIROVIM tijelom — ne c.req.json().
  const tijelo = await c.req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      tijelo,
      c.req.header('stripe-signature') ?? '',
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return c.text('neispravan potpis', 400);
  }

  const ishod = await obradiDogadaj(event, {
    fiskal: fiskalKlijent({ baseUrl: c.env.FISKAL_BASE_URL, apiKljuc: c.env.FISKAL_API_KEY }),
    postavke: {
      poslovniProstor: c.env.FISKAL_PROSTOR,
      naplatniUredaj: c.env.FISKAL_UREDAJ,
      operaterOib: c.env.FISKAL_OPERATER_OIB,
      pdvStopa: Number(c.env.FISKAL_PDV_STOPA || 0),
    },
    stavkeSessiona: async (id) => (await stripe.checkout.sessions.listLineItems(id, { limit: 100 })).data,
    spremiRacun: async (paymentIntentId, racun) => {
      // npr. UPDATE narudzbe SET fiskal_id = ?, broj_racuna = ?, jir = ? WHERE payment_intent = ?
      console.log('račun', paymentIntentId, racun.id, racun.brojRacuna, racun.jir);
    },
    posaljiEmail: true,
  });

  console.log(event.type, event.id, ishod.poruka);
  return ishod.ponovi ? c.text(ishod.poruka, 500) : c.json({ primljeno: true, poruka: ishod.poruka });
});

export default app;
