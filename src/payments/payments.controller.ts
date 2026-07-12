import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  constructor(private readonly paymentsService: PaymentsService) {}

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
