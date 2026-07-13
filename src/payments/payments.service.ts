import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Event, FeePayer } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Commission } from '../entities/commission.entity';
import { Refund, RefundStatus } from '../entities/refund.entity';
import { Payout, PayoutStatus } from '../entities/payout.entity';
import { FeeCalculationService, FeeBreakdown, OrganizerCommissionConfig } from './fee-calculation.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { NotificationService } from '../notifications/notification.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { getEventStartDateTime, getEventEndDateTime } from '../events/utils/event-dates.util';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(Commission)
    private readonly commissionsRepository: Repository<Commission>,
    @InjectRepository(Refund)
    private readonly refundsRepository: Repository<Refund>,
    @InjectRepository(Enrollment)
    private readonly enrollmentsRepository: Repository<Enrollment>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
    @InjectRepository(Payout)
    private readonly payoutsRepository: Repository<Payout>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly feeCalculationService: FeeCalculationService,
    private readonly waitlistService: WaitlistService,
    private readonly notificationService: NotificationService,
  ) {}

  // ---------------------------------------------------------------------
  // Fee calculation — standalone endpoint, callable from the Create Event
  // flow before the event is ever submitted for admin approval.
  // ---------------------------------------------------------------------
  async getFeeEstimate(dto: FeeEstimateDto, requestingUserId: string): Promise<FeeBreakdown> {
    const organizer = dto.organizerId
      ? await this.organizersRepository.findOne({ where: { id: dto.organizerId } })
      : await this.organizersRepository.findOne({ where: { userId: requestingUserId } });

    if (dto.organizerId && !organizer) {
      throw new NotFoundException(`Organizer ${dto.organizerId} not found`);
    }

    // No organizer profile yet (e.g. previewing fees before ever creating an event):
    // fall back to platform-default rates (0% + 0 flat) rather than failing the preview.
    const commissionConfig: OrganizerCommissionConfig = organizer
      ? { commissionRate: Number(organizer.commissionRate), commissionFlatFee: Number(organizer.commissionFlatFee) }
      : { commissionRate: 0, commissionFlatFee: 0 };

    return this.feeCalculationService.calculate(dto.ticketPrice, commissionConfig, dto.feePayer ?? FeePayer.ORGANIZER);
  }

  // ---------------------------------------------------------------------
  // Refund flow: request (participant) -> approve/reject (organizer/admin)
  // -> gateway refund call -> status update. Forward-only transitions are
  // enforced by Refund.canTransition().
  // ---------------------------------------------------------------------
  async requestRefund(userId: string, dto: RequestRefundDto): Promise<Refund> {
    const enrollment = await this.enrollmentsRepository.findOne({
      where: { id: dto.enrollmentId },
      relations: ['event'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.userId !== userId) {
      throw new ForbiddenException('You can only request a refund for your own booking');
    }
    if (enrollment.status === 'cancelled' || enrollment.status === 'refunded') {
      throw new BadRequestException('This booking is not eligible for a refund');
    }
    if (enrollment.paymentStatus !== 'paid') {
      throw new BadRequestException('This booking has no completed payment to refund');
    }

    const existingOpenRefund = await this.refundsRepository.findOne({
      where: { enrollmentId: enrollment.id, status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED]) },
    });
    if (existingOpenRefund) {
      throw new ConflictException('A refund request is already open for this booking');
    }

    // Settled decision: flat 48h cutoff before event start (see eventrixchanges.md).
    // Deliberately anchored to event *start*, not end — see loophole.md §3.3: for a
    // multi-day event this means the refund window closes 48h before Day 1 and stays
    // closed for the event's full duration. That's intentional product behavior (no
    // refunds once any part of a multi-day event has begun), not an inconsistency with
    // the end-anchored payout cron below.
    const windowHours = this.configService.get<number>('refund.windowHoursBeforeStart', 48);
    const cutoff = new Date(getEventStartDateTime(enrollment.event).getTime() - windowHours * 60 * 60 * 1000);
    if (new Date() >= cutoff) {
      throw new BadRequestException(`Refund requests are only accepted until ${windowHours}h before the event starts`);
    }

    const refund = this.refundsRepository.create({
      enrollmentId: enrollment.id,
      requestedBy: userId,
      reason: dto.reason,
      status: RefundStatus.REQUESTED,
      amount: enrollment.totalAmount,
      requestedAt: new Date(),
    });
    const saved = await this.refundsRepository.save(refund);
    this.logger.log(`Refund ${saved.id} requested for enrollment ${enrollment.id} by user ${userId}`);
    return saved;
  }

  async approveRefund(refundId: string, actorUserId: string, userRoles: string[]): Promise<Refund> {
    const refund = await this.findRefundOrFail(refundId);
    await this.assertCanManageRefund(refund, actorUserId, userRoles);

    if (!Refund.canTransition(refund.status, RefundStatus.APPROVED)) {
      throw new BadRequestException(`Cannot approve a refund in status "${refund.status}"`);
    }

    refund.status = RefundStatus.APPROVED;
    await this.refundsRepository.save(refund);
    this.logger.log(`Refund ${refund.id} approved by ${actorUserId}`);
    await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.APPROVED);

    return this.processGatewayRefund(refund);
  }

  async rejectRefund(refundId: string, reason: string, actorUserId: string, userRoles: string[]): Promise<Refund> {
    const refund = await this.findRefundOrFail(refundId);
    await this.assertCanManageRefund(refund, actorUserId, userRoles);

    if (!Refund.canTransition(refund.status, RefundStatus.REJECTED)) {
      throw new BadRequestException(`Cannot reject a refund in status "${refund.status}"`);
    }

    refund.status = RefundStatus.REJECTED;
    refund.processedAt = new Date();
    const saved = await this.refundsRepository.save(refund);
    this.logger.log(`Refund ${refund.id} rejected by ${actorUserId}: ${reason}`);
    await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.REJECTED);
    return saved;
  }

  async findPendingRefundsForOrganizer(userId: string, userRoles: string[]): Promise<Refund[]> {
    if (userRoles.includes('admin')) {
      return this.refundsRepository.find({ where: { status: RefundStatus.REQUESTED }, order: { requestedAt: 'ASC' } });
    }

    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) return [];

    return this.refundsRepository
      .createQueryBuilder('refund')
      .innerJoin('refund.enrollment', 'enrollment')
      .innerJoin('enrollment.event', 'event')
      .where('event.organizerId = :organizerId', { organizerId: organizer.id })
      .andWhere('refund.status = :status', { status: RefundStatus.REQUESTED })
      .orderBy('refund.requestedAt', 'ASC')
      .getMany();
  }

  // No live PayU/Razorpay integration exists yet — this is the single seam a future
  // gateway SDK call slots into. The forward-only state machine and status bookkeeping
  // around it are real.
  private async processGatewayRefund(refund: Refund): Promise<Refund> {
    try {
      refund.status = RefundStatus.PROCESSED;
      refund.gatewayRefundId = `mock_refund_${refund.id}`;
      refund.processedAt = new Date();
      const saved = await this.refundsRepository.save(refund);

      const enrollment = await this.enrollmentsRepository.findOne({ where: { id: refund.enrollmentId } });
      await this.enrollmentsRepository.update(refund.enrollmentId, {
        status: 'refunded',
        paymentStatus: 'refunded',
      });

      // Free the tier's capacity and hand the slot to the next FIFO waitlist entry.
      if (enrollment?.ticketTypeId) {
        await this.paymentsRepository.query(
          `UPDATE ticket_types SET quantity_sold = GREATEST(quantity_sold - $1, 0), updated_at = now() WHERE id = $2`,
          [enrollment.quantity, enrollment.ticketTypeId],
        );
        await this.waitlistService.promoteNext(enrollment.ticketTypeId);
      }

      this.logger.log(`Refund ${refund.id} processed via gateway (${refund.gatewayRefundId})`);
      await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.PROCESSED);
      return saved;
    } catch (err) {
      refund.status = RefundStatus.FAILED;
      const saved = await this.refundsRepository.save(refund);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Refund ${refund.id} gateway call failed: ${message}`);
      await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.FAILED);
      return saved;
    }
  }

  private async findRefundOrFail(refundId: string): Promise<Refund> {
    const refund = await this.refundsRepository.findOne({ where: { id: refundId } });
    if (!refund) throw new NotFoundException(`Refund ${refundId} not found`);
    return refund;
  }

  private async assertCanManageRefund(refund: Refund, userId: string, userRoles: string[]): Promise<void> {
    if (userRoles.includes('admin')) return;
    const enrollment = await this.enrollmentsRepository.findOne({
      where: { id: refund.enrollmentId },
      relations: ['event'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found for this refund');
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer || organizer.id !== enrollment.event.organizerId) {
      throw new ForbiddenException('You can only manage refunds for your own events');
    }
  }

  // ---------------------------------------------------------------------
  // Payment webhook idempotency: dedupe gateway retries on gatewayEventId,
  // wrap ticket issuance + payment confirmation in one transaction.
  // ---------------------------------------------------------------------
  async handleWebhook(dto: PaymentWebhookDto): Promise<Payment> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Payment, { where: { gatewayEventId: dto.gatewayEventId } });
      if (existing) {
        this.logger.log(`Duplicate webhook event ${dto.gatewayEventId} ignored (idempotent)`);
        return existing;
      }

      const enrollment = await manager.findOne(Enrollment, {
        where: { id: dto.enrollmentId },
        relations: ['event'],
      });
      if (!enrollment) throw new NotFoundException(`Enrollment ${dto.enrollmentId} not found`);

      const payment = manager.create(Payment, {
        enrollmentId: dto.enrollmentId,
        gateway: dto.gateway,
        gatewayPaymentId: dto.gatewayPaymentId,
        gatewayEventId: dto.gatewayEventId,
        amount: dto.amount,
        currency: enrollment.event.currency,
        status: dto.status === 'success' ? PaymentStatus.SUCCESS : PaymentStatus.FAILED,
      });

      let savedPayment: Payment;
      try {
        savedPayment = await manager.save(Payment, payment);
      } catch (err) {
        // Unique-violation race: two concurrent deliveries of the same gateway event both
        // passed the existence check above. Treat the loser as an idempotent duplicate.
        if ((err as { code?: string })?.code === '23505') {
          this.logger.warn(`Race on webhook idempotency key ${dto.gatewayEventId}; returning existing payment`);
          return manager.findOneOrFail(Payment, { where: { gatewayEventId: dto.gatewayEventId } });
        }
        throw err;
      }

      // A late or duplicate-gateway-retry webhook can arrive after the enrollment has
      // already been refunded/cancelled through a separate flow. Record the payment for
      // the audit trail either way, but never let it resurrect a terminal enrollment.
      if (enrollment.status === 'refunded' || enrollment.status === 'cancelled') {
        this.logger.warn(
          `Webhook ${dto.gatewayEventId} (${dto.status}) received for enrollment ${dto.enrollmentId} which is already "${enrollment.status}"; payment recorded but enrollment left untouched`,
        );
      } else if (dto.status === 'success') {
        const organizer = await manager.findOne(Organizer, { where: { id: enrollment.event.organizerId } });
        const breakdown = this.feeCalculationService.calculate(
          dto.amount,
          {
            commissionRate: Number(organizer?.commissionRate ?? 0),
            commissionFlatFee: Number(organizer?.commissionFlatFee ?? 0),
          },
          enrollment.event.feePayer,
        );

        await manager.save(
          Commission,
          manager.create(Commission, {
            paymentId: savedPayment.id,
            platformCommissionAmount: breakdown.platformCommissionAmount,
            gatewayFeeAmount: breakdown.gatewayFeeAmount,
          }),
        );

        enrollment.status = 'confirmed';
        enrollment.paymentStatus = 'paid';
        await manager.save(Enrollment, enrollment);
      } else {
        enrollment.paymentStatus = 'failed';
        await manager.save(Enrollment, enrollment);
      }

      this.logger.log(`Processed ${dto.gateway} webhook ${dto.gatewayEventId} for enrollment ${dto.enrollmentId}: ${dto.status}`);
      return savedPayment;
    });
  }

  // ---------------------------------------------------------------------
  // Payout cron: T+3 days after event end, batched per event, excluding
  // enrollments with an open (requested/approved) refund dispute.
  // ---------------------------------------------------------------------
  @Cron(CronExpression.EVERY_HOUR)
  async runPayoutSweep(): Promise<{ eventsProcessed: number; payoutsCreated: number }> {
    const delayDays = this.configService.get<number>('payout.delayDaysAfterEventEnd', 3);
    const now = new Date();

    const candidates = await this.enrollmentsRepository
      .createQueryBuilder('enrollment')
      .select('enrollment.eventId', 'eventId')
      .distinct(true)
      .where('enrollment.status = :status', { status: 'confirmed' })
      .andWhere('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' })
      .andWhere('enrollment.payoutId IS NULL')
      .getRawMany<{ eventId: string }>();

    let payoutsCreated = 0;
    for (const { eventId } of candidates) {
      const event = await this.eventsRepository.findOne({ where: { id: eventId } });
      if (!event) continue;

      const eligibleAt = new Date(getEventEndDateTime(event).getTime() + delayDays * 24 * 60 * 60 * 1000);
      if (now < eligibleAt) continue;

      const created = await this.settleEventPayout(event);
      if (created) payoutsCreated++;
    }

    this.logger.log(`Payout sweep: ${payoutsCreated} payout(s) created across ${candidates.length} candidate event(s)`);
    return { eventsProcessed: candidates.length, payoutsCreated };
  }

  private async settleEventPayout(event: Event): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      // Row-lock candidate enrollments so a concurrent sweep run can't double-pay. A
      // NOT EXISTS subquery (rather than a LEFT JOIN) keeps this a lockable single-table
      // scan — Postgres refuses FOR UPDATE across the nullable side of an outer join.
      const enrollments = await manager
        .createQueryBuilder(Enrollment, 'enrollment')
        .setLock('pessimistic_write')
        .where('enrollment.eventId = :eventId', { eventId: event.id })
        .andWhere('enrollment.status = :status', { status: 'confirmed' })
        .andWhere('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' })
        .andWhere('enrollment.payoutId IS NULL')
        .andWhere(
          `NOT EXISTS (SELECT 1 FROM refunds r WHERE r.enrollment_id = enrollment.id AND r.status IN (:...openStatuses))`,
          { openStatuses: [RefundStatus.REQUESTED, RefundStatus.APPROVED] },
        )
        .getMany();

      if (!enrollments.length) return false;

      const organizer = await manager.findOne(Organizer, { where: { id: event.organizerId } });
      if (!organizer) {
        this.logger.error(`Skipping payout for event ${event.id}: organizer ${event.organizerId} not found`);
        return false;
      }

      const commissionConfig: OrganizerCommissionConfig = {
        commissionRate: Number(organizer.commissionRate),
        commissionFlatFee: Number(organizer.commissionFlatFee),
      };

      const totalPayout = enrollments.reduce((sum, enrollment) => {
        const breakdown = this.feeCalculationService.calculate(Number(enrollment.totalAmount), commissionConfig, event.feePayer);
        return sum + breakdown.organizerPayout;
      }, 0);

      const payout = manager.create(Payout, {
        organizerId: event.organizerId,
        eventId: event.id,
        ticketCount: enrollments.length,
        amount: Math.round(totalPayout * 100) / 100,
        currency: event.currency,
        status: PayoutStatus.PAID,
        paidAt: new Date(),
      });
      const savedPayout = await manager.save(Payout, payout);

      await manager.update(
        Enrollment,
        enrollments.map((e) => e.id),
        { payoutId: savedPayout.id },
      );

      this.logger.log(
        `Payout ${savedPayout.id} created for event ${event.id} (organizer ${event.organizerId}): ` +
          `${enrollments.length} ticket(s), ${savedPayout.currency} ${savedPayout.amount}`,
      );
      return true;
    });
  }
}
