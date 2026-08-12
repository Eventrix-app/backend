import * as crypto from 'crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PayUService } from './payu.service';

describe('PayUService', () => {
  const MERCHANT_KEY = 'gtKFFx';
  const MERCHANT_SALT = 'eCwWELxi';
  let mockConfigService: any;
  let service: PayUService;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'payu.merchantKey') return MERCHANT_KEY;
        if (key === 'payu.merchantSalt') return MERCHANT_SALT;
        if (key === 'payu.baseUrl') return 'https://test.payu.in';
        return undefined;
      }),
    };
    service = new PayUService(mockConfigService);
  });

  describe('generateRequestHash', () => {
    it('matches the documented key|txnid|amount|productinfo|firstname|email|(10 blanks)|SALT format', () => {
      const input = { txnid: 'txn1', amount: 1000, productinfo: 'VIP Ticket', firstname: 'Aarish', email: 'a@example.com' };
      const expected = crypto
        .createHash('sha512')
        .update(
          [MERCHANT_KEY, 'txn1', '1000.00', 'VIP Ticket', 'Aarish', 'a@example.com', '', '', '', '', '', '', '', '', '', '', MERCHANT_SALT].join(
            '|',
          ),
        )
        .digest('hex');

      expect(service.generateRequestHash(input)).toBe(expected);
    });

    it('produces a different hash for a different amount (no accidental amount-independence)', () => {
      const base = { txnid: 'txn1', productinfo: 'VIP Ticket', firstname: 'Aarish', email: 'a@example.com' };
      const hash1 = service.generateRequestHash({ ...base, amount: 1000 });
      const hash2 = service.generateRequestHash({ ...base, amount: 2000 });
      expect(hash1).not.toBe(hash2);
    });

    it('throws instead of silently producing a hash PayU will always reject when unconfigured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      expect(() =>
        service.generateRequestHash({ txnid: 'txn1', amount: 1000, productinfo: 'x', firstname: 'x', email: 'x@example.com' }),
      ).toThrow(ServiceUnavailableException);
    });
  });

  describe('signHash', () => {
    it('appends the salt directly (no delimiter) and hashes with sha512, per the native SDK\'s generateHash convention', () => {
      const hashString = 'gtKFFx|txn1|1000.00|VIP Ticket|Aarish|a@example.com|||||||||||';
      const expected = crypto.createHash('sha512').update(`${hashString}${MERCHANT_SALT}`).digest('hex');

      expect(service.signHash(hashString)).toBe(expected);
    });

    it('produces a different hash for a different input string', () => {
      expect(service.signHash(`${MERCHANT_KEY}|a`)).not.toBe(service.signHash(`${MERCHANT_KEY}|b`));
    });

    it('throws instead of silently signing when unconfigured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      expect(() => service.signHash(`${MERCHANT_KEY}|anything`)).toThrow(ServiceUnavailableException);
    });

    // This endpoint applies the merchant salt to caller-supplied input, and PayU's
    // postservice API authenticates with the SAME sha512(...|SALT) construction. Signing
    // freely would let any authenticated user mint the hash for a refund call, be refunded
    // directly by PayU, and keep a booking our database still believes is paid.
    describe('privileged-command guard', () => {
      it('refuses to sign a refund-API hash string', () => {
        expect(() => service.signHash(`${MERCHANT_KEY}|cancel_refund_transaction|mihpay12345|`)).toThrow(
          BadRequestException,
        );
      });

      it.each([
        'cancel_refund_transaction',
        'refund_transaction',
        'cancel_transaction',
        'capture_transaction',
        'update_amount',
        'money_transfer',
        'payout',
        'delete_user_card',
      ])('refuses command %s', (command) => {
        expect(() => service.signHash(`${MERCHANT_KEY}|${command}|var1|`)).toThrow(BadRequestException);
      });

      it('is not fooled by casing or padding', () => {
        expect(() => service.signHash(`${MERCHANT_KEY}|Cancel_Refund_Transaction|x|`)).toThrow(BadRequestException);
        expect(() => service.signHash(`${MERCHANT_KEY}|  cancel_refund_transaction  |x|`)).toThrow(BadRequestException);
      });

      it('rejects a string that does not begin with the merchant key', () => {
        expect(() => service.signHash('someoneelseskey|cancel_refund_transaction|x|')).toThrow(BadRequestException);
        expect(() => service.signHash('arbitrary attacker chosen text')).toThrow(BadRequestException);
      });

      it('rejects an oversized string rather than hashing unbounded input', () => {
        expect(() => service.signHash(`${MERCHANT_KEY}|${'a'.repeat(5000)}`)).toThrow(BadRequestException);
      });

      // The guard must not break real checkout traffic — these are the shapes the SDK
      // actually asks for.
      it.each([
        ['checkout payment hash', `${MERCHANT_KEY}|txn1|1000.00|VIP Ticket|Aarish|a@example.com|||||||||||`],
        ['mobile SDK details lookup', `${MERCHANT_KEY}|payment_related_details_for_mobile_sdk|txn1|`],
        ['VAS lookup', `${MERCHANT_KEY}|vas_for_mobile_sdk|default|`],
        ['stored card fetch', `${MERCHANT_KEY}|get_user_cards|user-123|`],
      ])('still signs a legitimate %s', (_label, hashString) => {
        const expected = crypto.createHash('sha512').update(`${hashString}${MERCHANT_SALT}`).digest('hex');
        expect(service.signHash(hashString)).toBe(expected);
      });

      // Captured verbatim from a device run. This is the SDK's very first request, so
      // rejecting it strands checkout on a spinner with no terminal event ever firing.
      it('signs the get_checkout_details request the SDK opens checkout with', () => {
        const payload = JSON.stringify({
          requestId: 'ea03e501bd6e44eeamspw05fl1786526924567',
          transactionDetails: { amount: 1050, txnId: 'ea03e501bd6e44eeamspw05fl', source: 'Android_SDK' },
          customerDetails: { mobile: '7249210279' },
          useCase: { getAdditionalCharges: true, getSdkDetails: true },
          isSITxn: false,
        });
        const hashString = `${MERCHANT_KEY}|get_checkout_details|${payload}|`;
        const expected = crypto.createHash('sha512').update(`${hashString}${MERCHANT_SALT}`).digest('hex');

        expect(service.signHash(hashString)).toBe(expected);
      });
    });

    // A key configured with stray whitespace produced a 400 on every hash the SDK asked for,
    // which surfaced only as a checkout that never opened.
    describe('merchant key normalisation', () => {
      it.each([`${MERCHANT_KEY} `, ` ${MERCHANT_KEY}`, `${MERCHANT_KEY}\n`])(
        'signs normally when the configured key is %j',
        (configuredKey) => {
          mockConfigService.get.mockImplementation((k: string) => {
            if (k === 'payu.merchantKey') return configuredKey;
            if (k === 'payu.merchantSalt') return MERCHANT_SALT;
            return undefined;
          });

          const hashString = `${MERCHANT_KEY}|get_checkout_details|{}|`;
          expect(() => service.signHash(hashString)).not.toThrow();
        },
      );

      it('still rejects a genuinely different key', () => {
        expect(() => service.signHash('someoneelseskey|get_checkout_details|{}|')).toThrow(BadRequestException);
      });
    });
  });

  describe('verifyReverseHash', () => {
    const baseFields = {
      txnid: 'txn1',
      amount: '1000.00',
      productinfo: 'VIP Ticket',
      firstname: 'Aarish',
      email: 'a@example.com',
      status: 'success',
    };

    function computeReverseHash(fields: typeof baseFields): string {
      return crypto
        .createHash('sha512')
        .update(
          [
            MERCHANT_SALT,
            fields.status,
            '', '', '', '', '', '', '', '', '', '',
            fields.email,
            fields.firstname,
            fields.productinfo,
            fields.amount,
            fields.txnid,
            MERCHANT_KEY,
          ].join('|'),
        )
        .digest('hex');
    }

    it('accepts a hash computed the same way PayU computes it', () => {
      const hash = computeReverseHash(baseFields);
      expect(service.verifyReverseHash({ ...baseFields, hash })).toBe(true);
    });

    it('rejects a tampered amount even if the hash looked valid for the original', () => {
      const hash = computeReverseHash(baseFields);
      expect(service.verifyReverseHash({ ...baseFields, amount: '1.00', hash })).toBe(false);
    });

    it('rejects a tampered status (e.g. failure flipped to success) even with an otherwise-valid hash', () => {
      const hash = computeReverseHash({ ...baseFields, status: 'failure' });
      expect(service.verifyReverseHash({ ...baseFields, status: 'success', hash })).toBe(false);
    });

    it('rejects a garbage hash without throwing', () => {
      expect(service.verifyReverseHash({ ...baseFields, hash: 'not-a-real-hash' })).toBe(false);
    });
  });

  describe('refundTransaction', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns the refund id on an explicit success response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 1, request_id: 'req_123' }),
      }) as any;

      const result = await service.refundTransaction({ mihpayid: 'mihpay_1', amount: 500 });
      expect(result.refundId).toBe('req_123');
    });

    it('fails closed on an ambiguous/unrecognized response shape rather than assuming success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ someUnexpectedField: true }),
      }) as any;

      await expect(service.refundTransaction({ mihpayid: 'mihpay_1', amount: 500 })).rejects.toThrow();
    });

    it('fails closed on a non-OK HTTP response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
      await expect(service.refundTransaction({ mihpayid: 'mihpay_1', amount: 500 })).rejects.toThrow();
    });
  });
});
