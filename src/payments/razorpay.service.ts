import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';

import { PaymentGateway } from '../entities/payment.entity';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

// The single seam every Razorpay-specific detail (SDK calls, signature schemes, webhook
// payload shape) goes through — PaymentsController/PaymentsService stay gateway-agnostic,
// same separation FeeCalculationService already uses for fee math. Until
// RAZORPAY_KEY_ID/KEY_SECRET are set, order creation fails fast with a clear 503 instead of
// the SDK throwing an opaque 401 mid-request.
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private client: Razorpay | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getClient(): Razorpay {
    if (this.client) return this.client;
    const keyId = this.configService.get<string>('razorpay.keyId');
    const keySecret = this.configService.get<string>('razorpay.keySecret');
    if (!keyId || !keySecret) {
      throw new ServiceUnavailableException('Payment gateway is not configured');
    }
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    return this.client;
  }

  // Amount is the buyer-facing rupee amount (e.g. enrollment.totalAmount) — Razorpay
  // expects the smallest currency unit (paise for INR), converted here so every caller
  // works in ordinary rupees, matching how the rest of this app stores/displays amounts.
  async createOrder(amount: number, currency: string, receipt: string, notes: Record<string, string>) {
    return this.getClient().orders.create({
      amount: Math.round(amount * 100),
      currency,
      receipt,
      notes,
    });
  }

  // Fetches the order back from Razorpay so verifyPayment can confirm which enrollment
  // (and amount) it was actually created for — see the comment at that call site for why
  // this can't be skipped in favor of the checkout signature alone.
  async fetchOrder(orderId: string) {
    return this.getClient().orders.fetch(orderId);
  }

  get keyId(): string | undefined {
    return this.configService.get<string>('razorpay.keyId');
  }

  // Client-side checkout confirmation: the app calls this right after Razorpay's checkout
  // sheet reports success, before treating the booking as paid. Razorpay's documented
  // scheme is HMAC-SHA256 of "order_id|payment_id" keyed by the account secret — the SDK
  // only exposes this as an internal util (not a stable public API on the Razorpay class),
  // so it's computed directly here instead of reaching into the package's dist internals.
  // A forged client-side "success" callback can't produce a valid signature without the
  // secret; timingSafeEqual avoids leaking match-length via response-time differences.
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    const keySecret = this.configService.get<string>('razorpay.keySecret');
    if (!keySecret) {
      throw new ServiceUnavailableException('Payment gateway is not configured');
    }
    const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    return timingSafeEqualHex(expected, signature);
  }

  // Webhook signature scheme is a plain HMAC-SHA256 over the *raw* request body (not a
  // field composite like the checkout one above), keyed by the separate webhook secret
  // configured in the Razorpay dashboard — must be verified against the raw bytes, not a
  // re-serialized JSON.stringify(body), since re-serialization is not guaranteed to
  // reproduce the exact bytes Razorpay signed.
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const webhookSecret = this.configService.get<string>('razorpay.webhookSecret');
    if (!webhookSecret) {
      throw new ServiceUnavailableException('Payment gateway webhook is not configured');
    }
    return Razorpay.validateWebhookSignature(rawBody, signature, webhookSecret);
  }

  // Translates Razorpay's actual webhook payload shape into this app's gateway-agnostic
  // PaymentWebhookDto — the only place that shape is known. enrollmentId travels in the
  // order's `notes` (set at createOrder time) since Razorpay has no concept of it.
  // Returns null for event types Phase 1 doesn't act on (order.paid, refund.*, etc.) or a
  // payment missing its enrollmentId note, so the caller can just no-op.
  parseWebhookEvent(body: { event?: string; payload?: { payment?: { entity?: Record<string, any> } } }): PaymentWebhookDto | null {
    const event = body?.event;
    const payment = body?.payload?.payment?.entity;
    if (!payment) return null;

    const enrollmentId = payment.notes?.enrollmentId;
    if (!enrollmentId) {
      this.logger.warn(`Razorpay webhook "${event}" for payment ${payment.id} has no enrollmentId note; ignoring`);
      return null;
    }

    if (event === 'payment.captured') {
      return this.validateDto({
        gateway: PaymentGateway.RAZORPAY,
        gatewayEventId: payment.id,
        gatewayPaymentId: payment.id,
        enrollmentId,
        amount: payment.amount / 100,
        status: 'success',
      });
    }
    if (event === 'payment.failed') {
      return this.validateDto({
        gateway: PaymentGateway.RAZORPAY,
        gatewayEventId: payment.id,
        gatewayPaymentId: payment.id,
        enrollmentId,
        amount: payment.amount / 100,
        status: 'failed',
      });
    }
    return null;
  }

  // parseWebhookEvent's output is passed straight into PaymentsService.handleWebhook() as a
  // function argument, never through an @Body()-decorated controller parameter — so
  // PaymentWebhookDto's own class-validator decorators would otherwise never actually run
  // against a real Razorpay payload. A payload with a missing/malformed amount (e.g.
  // `payment.amount` absent) would silently produce `amount: NaN`, which is falsy enough to
  // skip commission calculation while the enrollment still gets confirmed as paid. Running
  // the same decorators here manually closes that gap without threading a real DTO through
  // an HTTP request pipeline that this data never actually travels through.
  private validateDto(candidate: PaymentWebhookDto): PaymentWebhookDto | null {
    const instance = plainToInstance(PaymentWebhookDto, candidate);
    const errors = validateSync(instance);
    if (errors.length > 0) {
      this.logger.warn(`Malformed Razorpay webhook payload for payment ${candidate.gatewayPaymentId}: ${errors.map((e) => e.toString()).join('; ')}`);
      return null;
    }
    return instance;
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
