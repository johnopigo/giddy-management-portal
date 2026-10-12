import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

const PAYSTACK = 'https://api.paystack.co';

/**
 * Paystack, when a secret key is configured. Amounts are in kobo.
 * https://paystack.com/docs/api/transaction/
 */
const paystack = {
  name: 'paystack',
  async initialize({ email, amount, reference, callbackUrl, metadata }) {
    const res = await fetch(`${PAYSTACK}/transaction/initialize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.paystackSecretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, amount: Math.round(amount * 100), currency: 'NGN', reference, callback_url: callbackUrl, metadata }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.status) throw new HttpError(502, 'The payment provider is not available right now. Please try again shortly.');
    return { url: body.data.authorization_url };
  },
  async verify(reference) {
    const res = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { authorization: `Bearer ${config.paystackSecretKey}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.status) return { status: 'unknown' };
    return { status: body.data.status, amount: body.data.amount / 100, currency: body.data.currency, raw: body.data };
  },
  /** Paystack signs webhooks with HMAC-SHA512 of the raw body using the secret key. */
  verifySignature(rawBody, signature) {
    if (!rawBody || !signature) return false;
    const expected = crypto.createHmac('sha512', config.paystackSecretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};

/**
 * A stand-in for development and tests: the guest is sent to a page in this app that says
 * "test payment" and lets them pay or decline. The outcome is stored on the booking.
 */
const testGateway = {
  name: 'test',
  async initialize({ reference }) {
    return { url: `${config.publicUrl}/book/pay/${encodeURIComponent(reference)}` };
  },
  async verify(reference, booking) {
    const outcome = booking?.gateway_data?.test_outcome;
    if (!outcome) return { status: 'pending' };
    return { status: outcome, amount: Number(booking.amount_due), currency: booking.currency };
  },
  verifySignature() { return false; },
};

export function gateway() {
  if (config.paystackSecretKey) return paystack;
  if (config.isProduction) throw new HttpError(503, 'Online payments are not set up yet.');
  return testGateway;
}

export function gatewayName() {
  return config.paystackSecretKey ? 'paystack' : config.isProduction ? 'none' : 'test';
}
