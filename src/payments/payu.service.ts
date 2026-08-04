import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

// Field names are unverified against a real PayU account (see class comment below) — kept
// loose/optional rather than asserted as guaranteed, since guessing wrong here should fail a
// type check, not silently trust an unverified shape.
interface PayURefundApiResponse {
  status?: number | string;
  msg?: string;
  request_id?: string | number;
}

// The single seam every PayU-specific detail (hash formats, refund API shape) goes through —
// PaymentsController/PaymentsService stay gateway-agnostic, same separation RazorpayService
// already uses. Until PAYU_MERCHANT_KEY/PAYU_MERCHANT_SALT are set, hash generation fails
// fast with a clear 503 instead of silently producing a hash PayU will always reject.
//
// Hash formats below were verified against PayU's official docs (docs.payu.in) rather than
// against a live PayU account — there is no way to test these end-to-end from this
// environment. Confirm byte-for-byte against a real test transaction before relying on this
// in production; a single wrong field silently breaks signature verification.
@Injectable()
export class PayUService {
  private readonly logger = new Logger(PayUService.name);

  constructor(private readonly configService: ConfigService) {}

  private getCredentials(): { key: string; salt: string } {
    const key = this.configService.get<string>('payu.merchantKey');
    const salt = this.configService.get<string>('payu.merchantSalt');
    if (!key || !salt) {
      throw new ServiceUnavailableException('Payment gateway is not configured');
    }
    return { key, salt };
  }

  get merchantKey(): string | undefined {
    return this.configService.get<string>('payu.merchantKey');
  }

  // PayU checkout and the refund/postservice API live on DIFFERENT production hostnames
  // (secure.payu.in vs info.payu.in) — they only happen to coincide in test mode
  // (test.payu.in serves both). A single PAYU_BASE_URL config value can't represent both, so
  // whether we're in test mode is derived from it, and each real endpoint is a fixed
  // constant chosen from that — swapping PAYU_BASE_URL away from a "test" host is what
  // flips both endpoints to their real production hosts together.
  get isTestMode(): boolean {
    return this.baseUrl.includes('test');
  }

  private get baseUrl(): string {
    return this.configService.get<string>('payu.baseUrl') || 'https://test.payu.in';
  }

  get actionUrl(): string {
    return this.isTestMode ? 'https://test.payu.in/_payment' : 'https://secure.payu.in/_payment';
  }

  private get refundApiUrl(): string {
    return this.isTestMode
      ? 'https://test.payu.in/merchant/postservice.php?form=2'
      : 'https://info.payu.in/merchant/postservice.php?form=2';
  }

  // Request hash — sent to PayU as the `hash` field in the checkout form. Documented format:
  // key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
  // (10 empty fields between email and SALT: 5 unused udf placeholders + 5 more reserved
  // blanks PayU's formula always includes). Built as an array join rather than a hand-typed
  // pipe string so the field count can't silently drift from what's documented above.
  generateRequestHash(input: { txnid: string; amount: number; productinfo: string; firstname: string; email: string }): string {
    const { key, salt } = this.getCredentials();
    const parts = [
      key,
      input.txnid,
      formatAmount(input.amount),
      input.productinfo,
      input.firstname,
      input.email,
      '', '', '', '', '', '', '', '', '', '',
      salt,
    ];
    return crypto.createHash('sha512').update(parts.join('|')).digest('hex');
  }

  // Reverse hash — verifies PayU's surl/furl callback actually came from PayU (a forged
  // callback can't reproduce a valid hash without the salt). Documented format:
  // SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
  // (10 empty fields between status and email: 5 reserved blanks + 5 unused udf placeholders,
  // reversed order relative to the request hash above).
  verifyReverseHash(input: {
    txnid: string;
    amount: string;
    productinfo: string;
    firstname: string;
    email: string;
    status: string;
    hash: string;
  }): boolean {
    const { key, salt } = this.getCredentials();
    const parts = [
      salt,
      input.status,
      '', '', '', '', '', '', '', '', '', '',
      input.email,
      input.firstname,
      input.productinfo,
      input.amount,
      input.txnid,
      key,
    ];
    const expected = crypto.createHash('sha512').update(parts.join('|')).digest('hex');
    return timingSafeEqualHex(expected, input.hash);
  }

  // Native SDK (payu-non-seam-less-react) checkout, unlike the WebView flow above, doesn't
  // take a pre-computed hash — it calls back into JS via a `generateHash` event whenever it
  // needs ANY hash (possibly more than once, for different hash types depending on payment
  // method), handing over the exact string to hash minus the salt. Confirmed by reading the
  // SDK's own native source (PayUBizSdkModule.java/PayUBizSdk.m): the event payload is
  // `{hashName, hashString, ...}` and the reply must be `{[hashName]: sha512(hashString+salt)}`.
  // Generic on purpose — this works for whatever hash type the SDK asks for, since the salt
  // never leaving the server is the only property that actually matters here, not knowing in
  // advance which specific hash type is being computed. PayU's own docs describe this as
  // "send this string to your backend and append the salt at the end" — direct concatenation,
  // no delimiter (unlike the pipe-joined formulas above, which already end in the right
  // number of empty fields before the salt is appended).
  signHash(hashStringWithoutSalt: string): string {
    const { salt } = this.getCredentials();
    return crypto.createHash('sha512').update(`${hashStringWithoutSalt}${salt}`).digest('hex');
  }

  // Refund Transaction API — a separate endpoint/hash scheme from checkout, keyed off
  // PayU's own payment id (mihpayid), not our txnid. Response field names are unverified
  // (no live sandbox access) — deliberately fails closed: anything other than an explicit,
  // documented success indicator throws, which PaymentsService.processGatewayRefund()
  // already routes to RefundStatus.FAILED rather than silently marking a refund processed.
  async refundTransaction(input: { mihpayid: string; amount: number }): Promise<{ refundId: string }> {
    const { key, salt } = this.getCredentials();
    const command = 'cancel_refund_transaction';
    const token = crypto.randomUUID();
    const hash = crypto.createHash('sha512').update(`${key}|${command}|${input.mihpayid}|${salt}`).digest('hex');

    const body = new URLSearchParams({
      key,
      command,
      var1: input.mihpayid,
      var2: token,
      var3: formatAmount(input.amount),
      hash,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(this.refundApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`PayU refund API returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as unknown as PayURefundApiResponse;
    // Documented convention: `status: 1` (or "1") indicates success. Treat anything else,
    // including a shape we don't recognize, as a failure rather than guessing.
    if (Number(data?.status) !== 1) {
      this.logger.warn(`PayU refund for ${input.mihpayid} was not confirmed successful: ${JSON.stringify(data)}`);
      throw new Error(data?.msg || 'PayU refund was not confirmed successful');
    }
    return { refundId: data.request_id ? String(data.request_id) : token };
  }
}

// PayU amounts are decimal rupee strings (e.g. "1000.00"), not paise like Razorpay — fixed
// to 2 decimal places since the hash is computed over the exact string sent to PayU, and a
// mismatched representation (e.g. "1000" vs "1000.00") would produce a different hash.
function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
