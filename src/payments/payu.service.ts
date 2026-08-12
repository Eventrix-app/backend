import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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

  // PAYU_CHECKOUT_URL / PAYU_API_URL pin a host explicitly; unset keeps the derived defaults
  // above, so an existing deployment with only PAYU_BASE_URL set behaves exactly as before.
  // Only the origin is configurable — the paths are PayU protocol, not deployment config.
  get actionUrl(): string {
    const configured = this.configService.get<string>('payu.checkoutUrl');
    const origin = configured || (this.isTestMode ? 'https://test.payu.in' : 'https://secure.payu.in');
    return `${trimTrailingSlash(origin)}/_payment`;
  }

  private get refundApiUrl(): string {
    const configured = this.configService.get<string>('payu.apiUrl');
    const origin = configured || (this.isTestMode ? 'https://test.payu.in' : 'https://info.payu.in');
    return `${trimTrailingSlash(origin)}/merchant/postservice.php?form=2`;
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
  // SECURITY: this is a salt-append oracle, and PayU's postservice API authenticates with
  // exactly the same construction — sha512(key|command|var1|SALT). Signing anything the
  // caller asks for therefore hands any authenticated user a valid hash for
  //
  //     key|cancel_refund_transaction|<mihpayid>|
  //
  // which is all that is needed to POST PayU's refund endpoint directly and be refunded,
  // while our database never learns of it: no Refund row, the enrollment stays confirmed and
  // paid, the ticket keeps working, and the payout sweep still pays the organizer. Free
  // tickets, with the platform absorbing the loss. The merchant key is public (it is handed
  // to the client by initiate-native) and a buyer's own mihpayid comes back in their own
  // payuResponse, so both inputs are already in the attacker's hands.
  //
  // Guarded with a denylist rather than an allowlist on purpose: the SDK requests hash types
  // that vary by payment method and cannot be enumerated from its source alone (they come
  // from PayU's compiled checkoutpro binary), so an allowlist would risk silently breaking a
  // real payment method that has never been exercised on a device here.
  //
  // The shape cannot be constrained either. A previous version also required the string to
  // START with the merchant key, on the assumption every genuine one does. A device run
  // disproved it: get_checkout_details and get_sdk_configuration do, while
  // get_all_offer_details and quickPayEvent do not, so real checkouts died on a 400 with the
  // SDK stuck waiting for a hash. Hence the command match scans every field rather than
  // anchoring on position, and nothing is asserted about the format.
  signHash(hashStringWithoutSalt: string): string {
    const { salt } = this.getCredentials();

    if (hashStringWithoutSalt.length > MAX_HASH_STRING_LENGTH) {
      throw new BadRequestException('Hash string is too long');
    }

    // Anywhere, not just index 1: the postservice construction puts the command there, but
    // position is exactly the assumption that broke checkout above.
    const denied = hashStringWithoutSalt
      .split('|')
      .map((field) => field.trim().toLowerCase())
      .find((field) => DENIED_HASH_COMMANDS.has(field));

    if (denied) {
      // Nothing legitimate reaches here — a client has asked us to authenticate a
      // money-moving postservice call. Logged at error so it surfaces as an incident.
      this.logger.error(`Rejected sign-hash request for privileged PayU command "${denied}"`);
      throw new BadRequestException('Unsupported hash string');
    }

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

// PayU postservice commands that move, reverse or capture money, or that mutate a stored
// instrument. None of these ever appear in a checkout hash, so refusing to sign them cannot
// break a payment — see the SECURITY note on signHash for what happens if they are signed.
// Stored lowercase; the check trims and lowercases before comparing.
const DENIED_HASH_COMMANDS: ReadonlySet<string> = new Set([
  'cancel_refund_transaction',
  'refund_transaction',
  'cancel_transaction',
  'capture_transaction',
  'update_amount',
  'update_requests',
  'money_transfer',
  'create_invoice',
  'delete_invoice',
  'payout',
  'instant_payout',
  'split_settlement',
  'save_user_card',
  'edit_user_card',
  'delete_user_card',
]);

// Generous relative to any real PayU hash string (the longest, the checkout request hash,
// is a few hundred characters) but bounded, so this endpoint can't be used to hash
// megabytes of attacker-chosen input.
const MAX_HASH_STRING_LENGTH = 2048;

// A configured origin with a trailing slash would otherwise produce a double slash in the
// path, which some gateways 404 on rather than normalise.
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
