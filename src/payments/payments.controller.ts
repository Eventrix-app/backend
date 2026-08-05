import { BadRequestException, Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, Request, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import * as crypto from 'crypto';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { CheckoutEstimateDto } from './dto/checkout-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { RejectRefundDto } from './dto/reject-refund.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { InitiatePayUOrderDto } from './dto/initiate-payu-order.dto';
import { PayUReturnDto } from './dto/payu-return.dto';
import { SignPayUHashDto } from './dto/sign-payu-hash.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PaymentStatus } from '../entities/payment.entity';
import { PayoutStatus } from '../entities/payout.entity';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly configService: ConfigService,
    private readonly razorpayService: RazorpayService,
  ) {}

  @Post('create-order')
  @HttpCode(HttpStatus.CREATED)
  async createOrder(@Body() dto: CreateOrderDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.createOrder(req.user.id, dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPayment(@Body() dto: VerifyPaymentDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.verifyPayment(req.user.id, dto);
  }

  // Active gateway — mirrors create-order above but for PayU's form-POST checkout flow.
  @Post('payu/initiate')
  @HttpCode(HttpStatus.CREATED)
  async initiatePayUOrder(@Body() dto: InitiatePayUOrderDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.initiatePayUOrder(req.user.id, dto);
  }

  // PayU redirects the paying browser/WebView here after checkout — surl and furl both
  // point at this one route, dto.status distinguishes success from failure. No user JWT is
  // presented (same trust model as the Razorpay `webhook` route below): the reverse hash,
  // verified inside handlePayUReturn, is what proves this actually came from PayU.
  //
  // @Body() is deliberately typed as a plain object, not PayUReturnDto, so the global
  // ValidationPipe (whitelist/forbidNonWhitelisted, see create-app.ts) never gets a chance to
  // reject a malformed body with a bare JSON 400 — this route must ALWAYS render the
  // HTML+postMessage page below, on every failure path, or the WebView has no way to close
  // itself. Validation happens manually inside the try/catch instead.
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('payu/return')
  @Header('Content-Type', 'text/html')
  async handlePayUReturn(@Body() body: Record<string, string>): Promise<string> {
    let success = false;
    try {
      const dto: PayUReturnDto = {
        txnid: body.txnid,
        mihpayid: body.mihpayid,
        status: body.status === 'success' ? 'success' : 'failure',
        amount: body.amount,
        productinfo: body.productinfo,
        firstname: body.firstname,
        email: body.email,
        hash: body.hash,
      };
      if (!dto.txnid || !dto.mihpayid || !dto.amount || !dto.hash) {
        throw new Error('Missing required PayU return fields');
      }
      const payment = await this.paymentsService.handlePayUReturn(dto);
      success = !!payment && dto.status === 'success';
    } catch (err) {
      this.logger.warn(`PayU return handling failed: ${err instanceof Error ? err.message : String(err)}`);
      success = false;
    }
    return payuReturnHtml(success);
  }

  // Native SDK (payu-non-seam-less-react) equivalent of payu/initiate — same validation,
  // different response shape (no pre-computed hash; the SDK asks for hashes on demand below).
  @Post('payu/initiate-native')
  @HttpCode(HttpStatus.CREATED)
  async initiatePayUNativeOrder(@Body() dto: InitiatePayUOrderDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.initiatePayUNativeOrder(req.user.id, dto);
  }

  // Called by the app's generateHash event handler (see Frontend's payuNativeService.ts) —
  // the native SDK can ask for a hash more than once per checkout, for different hash types,
  // handing over the exact string to hash minus the salt each time. Generic and JWT-guarded
  // (unlike payu/return, this is a direct authenticated call from our own app mid-session, not
  // an unauthenticated redirect from PayU's server) since the salt-secrecy property doesn't
  // depend on knowing which hash type is being requested.
  // Rate-limited on top of the merchant-key/command guard in PayUService.signHash: this is
  // the one endpoint that applies the merchant salt to caller-supplied input, so it should
  // never be cheap to probe in bulk. A real checkout asks for only a handful of hashes.
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('payu/sign-hash')
  @HttpCode(HttpStatus.OK)
  signPayUHash(@Body() dto: SignPayUHashDto, @Request() req: Request & { user: JwtPayload }) {
    // The signing endpoint is already JWT-guarded (no @Public decorator) — we extract the
    // user here so the service can log which session requested a hash, and as a future hook
    // for rate-limiting per-user salt-signing requests without changing the controller shape.
    void req.user; // intentionally referenced to keep the TS param used
    return { hash: this.paymentsService.signPayUHash(dto.hashString) };
  }

  // Native SDK's onPaymentSuccess/onPaymentFailure fire directly in the app, not via a
  // browser redirect — so unlike payu/return, this is a normal authenticated JSON endpoint
  // the app calls itself once it has parsed the SDK's payuResponse. Reuses the exact same
  // verification path (reverse-hash + amount check + handleWebhook) payu/return already
  // exercises — no new verification logic, just a different entry point into it.
  // SECURITY: This endpoint MUST remain JWT-guarded (no @Public decorator). An anonymous
  // caller who knows a txnid could otherwise forge a successful return and confirm an
  // enrollment they never paid for. The reverse-hash check in handlePayUReturn provides
  // a second layer, but the JWT is the primary gate.
  @Post('payu/verify-native')
  @HttpCode(HttpStatus.OK)
  async verifyPayUNative(@Body() dto: PayUReturnDto, @Request() req: Request & { user: JwtPayload }) {
    const payment = await this.paymentsService.handlePayUReturn(dto, req.user.id);
    return { success: !!payment && dto.status === 'success' };
  }

  // @Cron(EVERY_HOUR) in PaymentsService never fires on Vercel — serverless functions
  // don't keep a process running between requests. Vercel Cron Jobs (configured in
  // vercel.json's `crons`) hit this endpoint on a schedule instead, and Vercel
  // automatically attaches `Authorization: Bearer <CRON_SECRET>` when that env var is
  // set on the project — set CRON_SECRET there for this to actually run in production.
  @Public()
  @Get('payout-sweep')
  async triggerPayoutSweep(@Headers('authorization') authHeader?: string) {
    const expected = this.configService.get<string>('cron.secret');
    if (!expected) {
      throw new UnauthorizedException('Payout sweep trigger is not configured (CRON_SECRET missing)');
    }
    if (!authHeader || !timingSafeEqual(`Bearer ${expected}`, authHeader)) {
      throw new UnauthorizedException('Invalid cron secret');
    }
    return await this.paymentsService.runPayoutSweep();
  }

  // Standalone fee/payout estimate — callable from the Create Event flow before the
  // event is ever submitted for admin approval (see settled decision #1).
  @Get('fee-estimate')
  async getFeeEstimate(@Query() dto: FeeEstimateDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.getFeeEstimate(dto, req.user.id, req.user.roles);
  }

  // Buyer-facing counterpart to fee-estimate above: the exact total enroll() will charge for
  // a given tier + quantity. Unlike fee-estimate it takes no organizerId (the server resolves
  // it from the tier) and returns no organizer economics, so it needs no ownership guard —
  // see PaymentsService.getCheckoutEstimate.
  @Get('checkout-estimate')
  async getCheckoutEstimate(@Query() dto: CheckoutEstimateDto) {
    return await this.paymentsService.getCheckoutEstimate(dto);
  }

  // The one invoice endpoint. Both invoice UIs (BookingsScreen's Tax Invoice sheet and
  // InvoiceDetailScreen) read this same shape — a second, nested variant on `invoice/:id`
  // briefly existed and was removed: two routes returning the same booking in two formats
  // is two things to keep in sync for no benefit.
  @Get('invoices/:enrollmentId')
  async getTaxInvoice(@Param('enrollmentId', ParseUUIDPipe) enrollmentId: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.getTaxInvoice(req.user.id, enrollmentId);
  }

  @Post('refunds')
  @HttpCode(HttpStatus.CREATED)
  async requestRefund(@Body() dto: RequestRefundDto, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.requestRefund(req.user.id, dto);
  }

  @Get('refunds/pending')
  async findPendingRefunds(@Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.findPendingRefundsForOrganizer(req.user.id, req.user.roles);
  }

  // General-purpose admin transaction listing (not just pending refunds).
  @Roles('admin')
  @Get('admin')
  async findAllForAdmin(
    @Query('status') status?: PaymentStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (status !== undefined && !Object.values(PaymentStatus).includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    return await this.paymentsService.findAllForAdmin({
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // Admin listing over the payout ledger the T+3 cron sweep populates (see
  // runPayoutSweep) — a distinct static path from 'admin' above, no route-ordering concern.
  @Roles('admin')
  @Get('admin/payouts')
  async findAllPayoutsForAdmin(
    @Query('status') status?: PayoutStatus,
    @Query('organizerId') organizerId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (status !== undefined && !Object.values(PayoutStatus).includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    return await this.paymentsService.findAllPayoutsForAdmin({
      status,
      organizerId,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @AuditAction('refund.approve', 'refund')
  @Patch('refunds/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approveRefund(@Param('id', ParseUUIDPipe) id: string, @Request() req: Request & { user: JwtPayload }) {
    return await this.paymentsService.approveRefund(id, req.user.id, req.user.roles);
  }

  @AuditAction('refund.reject', 'refund')
  @Patch('refunds/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectRefund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectRefundDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    return await this.paymentsService.rejectRefund(id, dto.reason, req.user.id, req.user.roles);
  }

  // Gateway callback — no user JWT is presented, so the Razorpay request signature (HMAC
  // over the *raw* body, keyed by RAZORPAY_WEBHOOK_SECRET) is the only thing standing
  // between this endpoint and an attacker POSTing a fake "payment succeeded" body. Verified
  // against req.rawBody (captured by Nest's `rawBody: true` option in createApp) rather
  // than re-serializing req.body, since JSON.stringify is not guaranteed to reproduce the
  // exact bytes Razorpay signed.
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: RawBodyRequest<ExpressRequest>, @Headers('x-razorpay-signature') signature?: string) {
    if (!signature || !req.rawBody) {
      throw new UnauthorizedException('Missing webhook signature');
    }
    if (!this.razorpayService.verifyWebhookSignature(req.rawBody.toString('utf8'), signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const dto = this.razorpayService.parseWebhookEvent(req.body);
    if (!dto) {
      return { status: 'ignored' };
    }
    return await this.paymentsService.handleWebhook(dto);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// The only page PayU's redirect ever actually renders — caught by PayUCheckoutModal's
// WebView onMessage handler, mirroring how Razorpay's checkout.js `handler`/`ondismiss`
// callbacks report back to the same modal on the frontend side.
function payuReturnHtml(success: boolean): string {
  return `<!DOCTYPE html>
<html>
  <body>
    <script>
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: '${success ? 'success' : 'failure'}' }));
    </script>
  </body>
</html>`;
}
