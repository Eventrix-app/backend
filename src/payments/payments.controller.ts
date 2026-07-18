import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Request, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { RejectRefundDto } from './dto/reject-refund.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { JwtPayload } from '../auth/jwt.util';
import { Public } from '../common/decorators/public.decorator';
import { AuditAction } from '../common/decorators/audit-action.decorator';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly configService: ConfigService,
  ) {}

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
    if (authHeader !== `Bearer ${expected}`) {
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

  // Gateway callback — no user JWT is presented. A production deployment must verify the
  // gateway's request signature here before trusting the payload; that verification step
  // is gateway-SDK-specific and stubbed alongside the rest of the gateway integration.
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() dto: PaymentWebhookDto) {
    return await this.paymentsService.handleWebhook(dto);
  }
}
