import * as crypto from 'crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { RazorpayService } from './razorpay.service';
import { PaymentGateway } from '../entities/payment.entity';

describe('RazorpayService', () => {
  const WEBHOOK_SECRET = 'whsec_test_1234567890';
  const KEY_SECRET = 'keysec_test_1234567890';
  let mockConfigService: any;
  let service: RazorpayService;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'razorpay.webhookSecret') return WEBHOOK_SECRET;
        if (key === 'razorpay.keySecret') return KEY_SECRET;
        if (key === 'razorpay.keyId') return 'rzp_test_key';
        return undefined;
      }),
    };
    service = new RazorpayService(mockConfigService);
  });

  describe('verifyWebhookSignature', () => {
    it('accepts a signature computed the same way Razorpay computes it', () => {
      const rawBody = JSON.stringify({ event: 'payment.captured', payload: {} });
      const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

      expect(service.verifyWebhookSignature(rawBody, signature)).toBe(true);
    });

    it('rejects a tampered body even if the signature looked valid for the original', () => {
      const original = JSON.stringify({ event: 'payment.captured', payload: {} });
      const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(original).digest('hex');
      const tampered = JSON.stringify({ event: 'payment.captured', payload: { injected: true } });

      expect(service.verifyWebhookSignature(tampered, signature)).toBe(false);
    });

    it('throws instead of silently accepting requests when no webhook secret is configured', () => {
      mockConfigService.get.mockReturnValue(undefined);
      expect(() => service.verifyWebhookSignature('{}', 'anything')).toThrow(ServiceUnavailableException);
    });
  });

  describe('verifyCheckoutSignature', () => {
    it('accepts a signature computed over "order_id|payment_id"', () => {
      const signature = crypto.createHmac('sha256', KEY_SECRET).update('order_1|pay_1').digest('hex');
      expect(service.verifyCheckoutSignature('order_1', 'pay_1', signature)).toBe(true);
    });

    it('rejects a signature for a different order/payment pair', () => {
      const signature = crypto.createHmac('sha256', KEY_SECRET).update('order_1|pay_1').digest('hex');
      expect(service.verifyCheckoutSignature('order_2', 'pay_1', signature)).toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    const ENROLLMENT_UUID_1 = '11111111-1111-4111-8111-111111111111';
    const ENROLLMENT_UUID_2 = '22222222-2222-4222-8222-222222222222';

    it('maps a payment.captured event to a success PaymentWebhookDto', () => {
      const dto = service.parseWebhookEvent({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_1', amount: 19950, notes: { enrollmentId: ENROLLMENT_UUID_1 } } } },
      });

      expect(dto).toEqual({
        gateway: PaymentGateway.RAZORPAY,
        gatewayEventId: 'pay_1',
        gatewayPaymentId: 'pay_1',
        enrollmentId: ENROLLMENT_UUID_1,
        amount: 199.5,
        status: 'success',
      });
    });

    it('maps a payment.failed event to a failed PaymentWebhookDto', () => {
      const dto = service.parseWebhookEvent({
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_2', amount: 5000, notes: { enrollmentId: ENROLLMENT_UUID_2 } } } },
      });

      expect(dto?.status).toBe('failed');
    });

    it('rejects a malformed payload (e.g. non-numeric amount) instead of producing a NaN-amount DTO', () => {
      const dto = service.parseWebhookEvent({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_bad', notes: { enrollmentId: ENROLLMENT_UUID_1 } } } },
      });

      expect(dto).toBeNull();
    });

    it('ignores a payment with no enrollmentId note', () => {
      const dto = service.parseWebhookEvent({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_3', amount: 5000, notes: {} } } },
      });

      expect(dto).toBeNull();
    });

    it('ignores event types Phase 1 does not act on', () => {
      const dto = service.parseWebhookEvent({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_4', amount: 5000, notes: { enrollmentId: 'enr-4' } } } },
      });

      expect(dto).toBeNull();
    });
  });
});
