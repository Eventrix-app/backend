import * as crypto from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
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
      expect(service.signHash('a')).not.toBe(service.signHash('b'));
    });

    it('throws instead of silently signing when unconfigured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      expect(() => service.signHash('anything')).toThrow(ServiceUnavailableException);
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
