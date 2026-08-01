import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, Request, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import * as crypto from 'crypto';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { RejectRefundDto } from './dto/reject-refund.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PaymentStatus } from '../entities/payment.entity';
import { PayoutStatus } from '../entities/payout.entity';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
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
    return await this.paymentsService.getFeeEstimate(dto, req.user.id);
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
