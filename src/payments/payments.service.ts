import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Event, EventStatus, FeePayer } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { Payment, PaymentGateway, PaymentStatus } from '../entities/payment.entity';
import { Commission } from '../entities/commission.entity';
import { Refund, RefundStatus } from '../entities/refund.entity';
import { Payout, PayoutStatus } from '../entities/payout.entity';
import { TicketType } from '../entities/ticket-type.entity';
import {
  FeeCalculationService,
  FeeBreakdown,
  OrganizerCommissionConfig,
  toCommissionConfig,
  toFrozenFeeColumns,
  readFrozenBreakdown,
} from './fee-calculation.service';
import type { InvoiceEmailLine } from '../email/templates';
import { RazorpayService } from './razorpay.service';
import { PayUService } from './payu.service';
import { LedgerService } from './ledger.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { NotificationService } from '../notifications/notification.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { CheckoutEstimateDto } from './dto/checkout-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { InitiatePayUOrderDto } from './dto/initiate-payu-order.dto';
import { PayUReturnDto } from './dto/payu-return.dto';
import { getEventStartDateTime, getEventEndDateTime } from '../events/utils/event-dates.util';
import { invalidateEventCaches } from '../events/utils/event-cache.util';
import { CacheService } from '../common/cache/cache.service';
import { toTenDigitMobile } from '../common/phone.util';

// Enrollment.user is the full User entity (passwordHash included), so the refund queue
// must scope its select. Event/user context eager-loaded for the approval screen.
const REFUND_SAFE_ENROLLMENT_SELECT = {
  id: true,
  bookingReference: true,
  quantity: true,
  totalAmount: true,
  event: { id: true, title: true, eventDate: true, startTime: true, coverImageUrl: true },
  user: { id: true, email: true, fullName: true },
} as const;

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
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Payout)
    private readonly payoutsRepository: Repository<Payout>,
    @InjectRepository(TicketType)
    private readonly ticketTypesRepository: Repository<TicketType>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly feeCalculationService: FeeCalculationService,
    private readonly waitlistService: WaitlistService,
    private readonly notificationService: NotificationService,
    private readonly cache: CacheService,
    private readonly razorpayService: RazorpayService,
    private readonly payuService: PayUService,
    private readonly ledgerService: LedgerService,
  ) {}

  // Razorpay checkout: create-order -> client verify -> handleWebhook.
  // Verify and webhook share a gatewayEventId, so whichever lands first wins.
  async createOrder(userId: string, dto: CreateOrderDto) {
    const enrollment = await this.enrollmentsRepository.findOne({
      where: { id: dto.enrollmentId },
      relations: ['event'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.userId !== userId) {
      throw new ForbiddenException('You can only pay for your own booking');
    }
    if (enrollment.paymentStatus !== 'pending') {
      throw new BadRequestException('This booking does not have a pending payment');
    }
    if (!(Number(enrollment.totalAmount) > 0)) {
      throw new BadRequestException('Free bookings do not require a payment order');
    }

    const order = await this.razorpayService.createOrder(
      Number(enrollment.totalAmount),
      enrollment.event.currency || 'INR',
      `enrollment_${enrollment.id}`,
      { enrollmentId: enrollment.id, userId },
    );

    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: this.razorpayService.keyId,
    };
  }

  async verifyPayment(userId: string, dto: VerifyPaymentDto): Promise<Payment> {
    const enrollment = await this.enrollmentsRepository.findOne({ where: { id: dto.enrollmentId } });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.userId !== userId) {
      throw new ForbiddenException('You can only confirm your own booking');
    }

    const isValid = this.razorpayService.verifyCheckoutSignature(
      dto.razorpayOrderId,
      dto.razorpayPaymentId,
      dto.razorpaySignature,
    );
    if (!isValid) {
      throw new BadRequestException('Payment signature verification failed');
    }

    // The signature proves the (orderId, paymentId) pair is genuine, not which enrollment
    // it was for — without this a valid triple could be replayed against a pricier booking.
    const order = await this.razorpayService.fetchOrder(dto.razorpayOrderId);
    const orderEnrollmentId = (order.notes as Record<string, unknown> | undefined)?.enrollmentId;
    if (orderEnrollmentId !== enrollment.id) {
      throw new BadRequestException('Order does not match this booking');
    }
    const expectedAmountPaise = Math.round(Number(enrollment.totalAmount) * 100);
    if (Number(order.amount) !== expectedAmountPaise) {
      throw new BadRequestException('Order amount does not match this booking');
    }

    return this.handleWebhook({
      gateway: PaymentGateway.RAZORPAY,
      gatewayEventId: dto.razorpayPaymentId,
      gatewayPaymentId: dto.razorpayPaymentId,
      enrollmentId: enrollment.id,
      amount: Number(enrollment.totalAmount),
      status: 'success',
    });
  }

  // PayU is the active gateway (Razorpay kept working but dormant). We mint txnid+hash,
  // the client POSTs to PayU's hosted page, and surl/furl redirect back to handlePayUReturn.
  async initiatePayUOrder(userId: string, dto: InitiatePayUOrderDto) {
    const { txnid, amount, productinfo, firstname, email, user } = await this.resolvePendingPayUAttempt(
      userId,
      dto.enrollmentId,
    );

    const hash = this.payuService.generateRequestHash({ txnid, amount, productinfo, firstname, email });

    return {
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      phone: toPayuPhone(user.phoneNumber),
      key: this.payuService.merchantKey,
      hash,
      actionUrl: this.payuService.actionUrl,
    };
  }

  // Native SDK path: no pre-computed hash — the SDK requests hashes on demand.
  // Field names are the SDK's camelCase, not the classic flow's lowercase.
  async initiatePayUNativeOrder(userId: string, dto: InitiatePayUOrderDto) {
    const { txnid, amount, productinfo, firstname, email, user } = await this.resolvePendingPayUAttempt(
      userId,
      dto.enrollmentId,
    );

    return {
      key: this.payuService.merchantKey,
      transactionId: txnid,
      amount,
      productInfo: productinfo,
      firstName: firstname,
      email,
      phone: toPayuPhone(user.phoneNumber),
      // "1" = test mode, "0" = production, per PayUBizConstants.ENVIRONMENT — a string, not a
      // boolean, matching the SDK's own native constant type.
      environment: this.payuService.isTestMode ? '1' : '0',
    };
  }

  // Shared by both PayU paths: validates ownership/status/amount, mints the txnid, and
  // strips characters PayU's pipe-delimited hash is sensitive to.
  private async resolvePendingPayUAttempt(userId: string, enrollmentId: string) {
    const enrollment = await this.enrollmentsRepository.findOne({
      where: { id: enrollmentId },
      relations: ['event'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.userId !== userId) {
      throw new ForbiddenException('You can only pay for your own booking');
    }
    if (enrollment.paymentStatus !== 'pending') {
      throw new BadRequestException('This booking does not have a pending payment');
    }
    if (!(Number(enrollment.totalAmount) > 0)) {
      throw new BadRequestException('Free bookings do not require a payment order');
    }

    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Fresh txnid per attempt — PayU rejects a reused one, which would break retry entirely.
    // resolveEnrollmentForTxnid decodes this format; changing it loses late callbacks.
    const txnid = `${enrollment.id.replace(/-/g, '').slice(0, ENROLLMENT_ID_PREFIX_LENGTH)}${Date.now().toString(36)}`;
    assertValidPayUTxnId(txnid);
    await this.enrollmentsRepository.update(enrollment.id, { payuTxnId: txnid });

    // A literal pipe in a free-text field shifts every later field and breaks the hash.
    // Stripped, not escaped: PayU echoes it back verbatim and it must match byte-for-byte.
    const amount = Number(enrollment.totalAmount);
    const productinfo = sanitizePayUField(enrollment.event.title).slice(0, 100);
    const firstname = sanitizePayUField((user.fullName || 'Guest').split(' ')[0]).slice(0, 60);
    const email = user.email;

    return { enrollment, user, txnid, amount, productinfo, firstname, email };
  }

  // Resolves the enrollment for a callback, including a SUPERSEDED attempt: each retry
  // overwrites payuTxnId, so a late callback for an earlier attempt was silently lost.
  private async resolveEnrollmentForTxnid(txnid: string): Promise<Enrollment | null> {
    const exact = await this.enrollmentsRepository.findOne({
      where: { payuTxnId: txnid },
      relations: ['event'],
    });
    if (exact) return exact;

    // Hex-only prefix, built from the constant — hardcoding this length silently broke
    // superseded-callback recovery when the prefix shortened, dropping payments.
    const prefix = txnid.slice(0, ENROLLMENT_ID_PREFIX_LENGTH).toLowerCase();
    if (!new RegExp(`^[0-9a-f]{${ENROLLMENT_ID_PREFIX_LENGTH}}$`).test(prefix)) return null;

    const matches = await this.enrollmentsRepository
      .createQueryBuilder('enrollment')
      .leftJoinAndSelect('enrollment.event', 'event')
      .where(`REPLACE(enrollment.id::text, '-', '') LIKE :prefix`, { prefix: `${prefix}%` })
      .limit(2)
      .getMany();

    // 68 bits of uuid make a collision negligible, but guessing between two bookings would
    // mean confirming the wrong one — refuse rather than pick.
    if (matches.length !== 1) {
      if (matches.length > 1) {
        this.logger.error(`PayU txnid ${txnid} prefix matched ${matches.length} enrollments; refusing to guess`);
      }
      return null;
    }

    this.logger.warn(
      `PayU callback for superseded txnid ${txnid} resolved to enrollment ${matches[0].id} via id prefix ` +
        `(current attempt is ${matches[0].payuTxnId ?? 'none'})`,
    );
    return matches[0];
  }

  // The salt must never leave the server, so this is the one seam that crosses it.
  // Generic on purpose: works for whatever hash type the SDK asks for.
  signPayUHash(hashString: string): string {
    return this.payuService.signHash(hashString);
  }

  // Handles both surl and furl, and must never throw past the controller: a WebView stuck
  // on a JSON error page cannot close itself. callerUserId scopes the authenticated path.
  async handlePayUReturn(dto: PayUReturnDto, callerUserId?: string): Promise<Payment | null> {
    const enrollment = await this.resolveEnrollmentForTxnid(dto.txnid);
    if (!enrollment) {
      this.logger.warn(`PayU return for unknown txnid ${dto.txnid}`);
      return null;
    }

    // Ownership check for the JWT-authenticated native SDK path.
    if (callerUserId && enrollment.userId !== callerUserId) {
      this.logger.warn(`PayU native verify: txnid ${dto.txnid} belongs to user ${enrollment.userId}, but caller is ${callerUserId}`);
      return null;
    }

    if (!this.payuService.verifyReverseHash(dto)) {
      this.logger.warn(`PayU return for txnid ${dto.txnid} failed reverse-hash verification`);
      return null;
    }

    // Amount is compared in integer paise, not raw floats, mirroring how verifyPayment()
    // avoids float-comparison bugs for Razorpay's own amount cross-check.
    const expectedPaise = Math.round(Number(enrollment.totalAmount) * 100);
    const actualPaise = Math.round(Number(dto.amount) * 100);
    if (expectedPaise !== actualPaise) {
      this.logger.warn(`PayU return for txnid ${dto.txnid}: amount mismatch (expected ${expectedPaise}, got ${actualPaise})`);
      return null;
    }

    return this.handleWebhook({
      gateway: PaymentGateway.PAYU,
      gatewayEventId: dto.mihpayid,
      gatewayPaymentId: dto.mihpayid,
      enrollmentId: enrollment.id,
      amount: Number(dto.amount),
      status: dto.status === 'success' ? 'success' : 'failed',
    });
  }

  // Fee estimate — callable from Create Event before the event is submitted for approval.
  async getFeeEstimate(dto: FeeEstimateDto, requestingUserId: string, requestingUserRoles: string[]): Promise<FeeBreakdown> {
    const organizer = dto.organizerId
      ? await this.organizersRepository.findOne({ where: { id: dto.organizerId } })
      : await this.organizersRepository.findOne({ where: { userId: requestingUserId } });

    if (dto.organizerId && !organizer) {
      throw new NotFoundException(`Organizer ${dto.organizerId} not found`);
    }

    // B2 fix: a non-admin caller may only query their own organizer profile. Admins may
    // look up any organizer's rates (e.g. from the admin dashboard fee preview tool).
    if (
      dto.organizerId &&
      !requestingUserRoles.includes('admin') &&
      organizer?.userId !== requestingUserId
    ) {
      throw new ForbiddenException('You can only view fee estimates for your own organizer profile');
    }

    // No organizer profile yet (e.g. previewing fees before ever creating an event):
    // fall back to platform-default rates (0% + 0 flat) rather than failing the preview.
    const commissionConfig: OrganizerCommissionConfig = organizer
      ? toCommissionConfig(organizer)
      // No organizer profile yet (previewing fees before ever creating an event): resolve to
      // the platform default rather than an optimistic zero, so the preview matches reality.
      : toCommissionConfig(null);

    return this.feeCalculationService.calculate(dto.ticketPrice, commissionConfig, dto.feePayer ?? FeePayer.ORGANIZER);
  }

  // Uses the same FeeCalculationService call enroll() makes, so the "Pay ₹X" button can
  // never state a different number from what the gateway is charged. Buyer-visible lines only.
  async getCheckoutEstimate(dto: CheckoutEstimateDto) {
    const ticketType = await this.ticketTypesRepository.findOne({
      where: { id: dto.ticketTypeId },
      relations: ['event', 'event.organizer'],
    });
    if (!ticketType) throw new NotFoundException('Ticket type not found');

    const unitPrice = Number(ticketType.price);
    const subtotal = this.roundMoney(unitPrice * dto.quantity);
    const feePayer = ticketType.event.feePayer;

    // Mirrors EventsService.enroll(): the base amount is price x quantity, and fees are
    // computed on that total, not per ticket.
    const breakdown = this.feeCalculationService.calculate(
      subtotal,
      toCommissionConfig(ticketType.event.organizer),
      feePayer,
    );

    const isFreeEvent = subtotal <= 0;
    const lines: { label: string; amount: number }[] = [];

    // Free events charge only the flat registration fee, and calculate() forces feePayer to
    // PARTICIPANT there, so this is checked before the branch below.
    if (isFreeEvent) {
      if (breakdown.buyerPrice > 0) {
        lines.push({ label: 'Platform fee', amount: breakdown.buyerPrice });
      }
    } else if (feePayer === FeePayer.PARTICIPANT && breakdown.buyerPrice > 0) {
      if (breakdown.platformCommissionAmount > 0) {
        lines.push({ label: 'Platform fee', amount: breakdown.platformCommissionAmount });
      }
      if (breakdown.gatewayFeeAmount > 0) {
        lines.push({ label: 'Payment gateway fee', amount: breakdown.gatewayFeeAmount });
      }
      if (breakdown.gstAmount > 0) {
        const rate = Math.round((breakdown.gstAmount / breakdown.platformCommissionAmount) * 10000) / 100;
        lines.push({
          label: Number.isFinite(rate) && rate > 0 ? `GST (${rate}% on platform fee)` : 'GST on platform fee',
          amount: breakdown.gstAmount,
        });
      }
    }

    return {
      ticketTypeId: ticketType.id,
      unitPrice,
      quantity: dto.quantity,
      subtotal,
      feePayer,
      // Lets the app explain why a ticket priced at 0 still costs something, rather than
      // looking like a bug.
      isFreeEvent,
      currency: ticketType.currency || ticketType.event.currency || 'INR',
      lines,
      // What enroll() will persist as enrollment.totalAmount and what PayU will be asked to
      // charge — free tiers included (buyerPrice is 0 there).
      total: breakdown.buyerPrice,
    };
  }

  private roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  // Refund flow: request -> approve/reject -> gateway call -> status update.
  // Forward-only transitions are enforced by Refund.canTransition().
  async requestRefund(userId: string, dto: RequestRefundDto): Promise<Refund> {
    // Locks the enrollment for the exists-check plus insert: two near-simultaneous requests
    // could otherwise both pass and be approved separately, double-refunding the booking.
    const { saved, eventTitle } = await this.dataSource.transaction(async (manager) => {
      const enrollment = await manager
        .createQueryBuilder(Enrollment, 'enrollment')
        .setLock('pessimistic_write')
        .leftJoinAndSelect('enrollment.event', 'event')
        .where('enrollment.id = :id', { id: dto.enrollmentId })
        .getOne();
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

      const existingOpenRefund = await manager.findOne(Refund, {
        where: { enrollmentId: enrollment.id, status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED]) },
      });
      if (existingOpenRefund) {
        throw new ConflictException('A refund request is already open for this booking');
      }

    // Flat 48h cutoff anchored to event START, not end — for a multi-day event the window
    // closes 48h before Day 1 and stays closed. Intentional (loophole.md §3.3).
      const windowHours = this.configService.get<number>('refund.windowHoursBeforeStart', 48);
      const cutoff = new Date(getEventStartDateTime(enrollment.event).getTime() - windowHours * 60 * 60 * 1000);
      if (new Date() >= cutoff) {
        throw new BadRequestException(`Refund requests are only accepted until ${windowHours}h before the event starts`);
      }

      const refund = manager.create(Refund, {
        enrollmentId: enrollment.id,
        requestedBy: userId,
        reason: dto.reason,
        status: RefundStatus.REQUESTED,
        amount: enrollment.totalAmount,
        requestedAt: new Date(),
      });
      return { saved: await manager.save(Refund, refund), eventTitle: enrollment.event?.title ?? 'an event' };
    });

    this.logger.log(`Refund ${saved.id} requested for enrollment ${saved.enrollmentId} by user ${userId}`);
    await this.notificationService.notifyRefundStatus(userId, saved.id, RefundStatus.REQUESTED, saved.enrollmentId);
    // Puts the request in front of whoever decides it. Fire-and-forget: the refund row is
    // committed and must not roll back over a notification failure.
    void this.notifyAdminsOfRefundRequest(saved.id, saved.enrollmentId, Number(saved.amount), userId, eventTitle);
    return saved;
  }

  private async notifyAdminsOfRefundRequest(
    refundId: string,
    enrollmentId: string,
    amount: number,
    requesterId: string,
    eventTitle: string,
  ): Promise<void> {
    try {
      const requester = await this.usersRepository.findOne({ where: { id: requesterId }, select: ['fullName'] });
      await this.notificationService.notifyAdminsRefundRequested(
        refundId,
        enrollmentId,
        amount,
        requester?.fullName ?? 'A participant',
        eventTitle,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to notify admins of refund ${refundId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async approveRefund(refundId: string, actorUserId: string, userRoles: string[]): Promise<Refund> {
    const refund = await this.findRefundOrFail(refundId);
    await this.assertCanManageRefund(refund, actorUserId, userRoles);

    // Row-locked: two concurrent approvals could both pass canTransition and both refund,
    // double-decrementing capacity and double-promoting the waitlist.
    const approved = await this.lockAndTransitionRefund(refundId, RefundStatus.APPROVED);

    this.logger.log(`Refund ${approved.id} approved by ${actorUserId}`);
    await this.notificationService.notifyRefundStatus(approved.requestedBy, approved.id, RefundStatus.APPROVED, approved.enrollmentId);

    return this.processGatewayRefund(approved);
  }

  async rejectRefund(refundId: string, reason: string, actorUserId: string, userRoles: string[]): Promise<Refund> {
    const refund = await this.findRefundOrFail(refundId);
    await this.assertCanManageRefund(refund, actorUserId, userRoles);

    const rejected = await this.lockAndTransitionRefund(refundId, RefundStatus.REJECTED, { processedAt: new Date() });

    this.logger.log(`Refund ${rejected.id} rejected by ${actorUserId}: ${reason}`);
    await this.notificationService.notifyRefundStatus(rejected.requestedBy, rejected.id, RefundStatus.REJECTED, rejected.enrollmentId);
    return rejected;
  }

  // Locks the refund row for the duration of the status check + write so two concurrent
  // callers can't both observe the pre-transition status and both proceed.
  private async lockAndTransitionRefund(
    refundId: string,
    nextStatus: RefundStatus,
    extraFields: Partial<Refund> = {},
  ): Promise<Refund> {
    return this.dataSource.transaction(async (manager) => {
      const locked = await manager
        .createQueryBuilder(Refund, 'refund')
        .setLock('pessimistic_write')
        .where('refund.id = :id', { id: refundId })
        .getOne();
      if (!locked) throw new NotFoundException(`Refund ${refundId} not found`);
      if (!Refund.canTransition(locked.status, nextStatus)) {
        throw new BadRequestException(`Cannot ${nextStatus === RefundStatus.APPROVED ? 'approve' : 'reject'} a refund in status "${locked.status}"`);
      }
      Object.assign(locked, extraFields, { status: nextStatus });
      return manager.save(Refund, locked);
    });
  }

  async findPendingRefundsForOrganizer(userId: string, userRoles: string[]): Promise<Refund[]> {
    if (userRoles.includes('admin')) {
      return this.refundsRepository.find({
        where: { status: RefundStatus.REQUESTED },
        relations: ['enrollment', 'enrollment.event', 'enrollment.user'],
        select: { enrollment: REFUND_SAFE_ENROLLMENT_SELECT as any },
        order: { requestedAt: 'ASC' },
      });
    }

    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) return [];

    return this.refundsRepository
      .createQueryBuilder('refund')
      .innerJoin('refund.enrollment', 'enrollment')
      .addSelect(['enrollment.id', 'enrollment.bookingReference', 'enrollment.quantity', 'enrollment.totalAmount'])
      .innerJoin('enrollment.event', 'event')
      .addSelect(['event.id', 'event.title', 'event.eventDate', 'event.startTime', 'event.coverImageUrl'])
      .leftJoin('enrollment.user', 'enrollmentUser')
      .addSelect(['enrollmentUser.id', 'enrollmentUser.email', 'enrollmentUser.fullName'])
      .where('event.organizerId = :organizerId', { organizerId: organizer.id })
      .andWhere('refund.status = :status', { status: RefundStatus.REQUESTED })
      .orderBy('refund.requestedAt', 'ASC')
      .getMany();
  }

  // Joins through Enrollment using the same allowlist REFUND_SAFE_ENROLLMENT_SELECT uses,
  // so a payment row never leaks the enrollment user's passwordHash.
  async findAllForAdmin(filters: {
    status?: PaymentStatus;
    page?: number;
    limit?: number;
  }): Promise<{ payments: Payment[]; total: number; page: number; totalPages: number }> {
    const { status, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;

    const [payments, total] = await this.paymentsRepository.findAndCount({
      where,
      relations: ['enrollment', 'enrollment.event', 'enrollment.user'],
      select: { enrollment: REFUND_SAFE_ENROLLMENT_SELECT as any },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { payments, total, page, totalPages: Math.ceil(total / limit) };
  }

  // Admin listing over the payout ledger the T+3 cron sweep (runPayoutSweep, below) already
  // populates — that sweep only ever wrote rows, nothing read them back until this.
  async findAllPayoutsForAdmin(filters: {
    status?: PayoutStatus;
    organizerId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ payouts: Payout[]; total: number; page: number; totalPages: number }> {
    const { status, organizerId, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;
    if (organizerId) where.organizerId = organizerId;

    const [payouts, total] = await this.payoutsRepository.findAndCount({
      where,
      relations: ['organizer', 'organizer.user', 'event'],
      select: {
        organizer: { id: true, companyName: true, user: { id: true, fullName: true, email: true } },
        event: { id: true, title: true },
      },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { payouts, total, page, totalPages: Math.ceil(total / limit) };
  }

  // Scoped by session user id, not a parameter, so another organizer's history is unaskable.
  // Lean projection drops admin-only fields rather than trusting a downstream serializer.
  async findMyPayouts(
    userId: string,
    filters: { page?: number; limit?: number } = {},
  ): Promise<{ payouts: OrganizerPayoutView[]; total: number; page: number; totalPages: number }> {
    const { page = 1, limit = 20 } = filters;

    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    // No organizer row = never hosted; an empty page renders the right empty state
    if (!organizer) return { payouts: [], total: 0, page, totalPages: 0 };

    const [payouts, total] = await this.payoutsRepository.findAndCount({
      where: { organizerId: organizer.id },
      relations: ['event'],
      select: { event: { id: true, title: true, eventDate: true, coverImageUrl: true } },
      // id tiebreaker keeps pagination deterministic when the sweep creates rows together
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      payouts: payouts.map((p) => ({
        id: p.id,
        eventId: p.eventId,
        eventTitle: p.event?.title ?? 'Event',
        eventDate: p.event?.eventDate,
        eventCoverImageUrl: p.event?.coverImageUrl,
        ticketCount: p.ticketCount,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.status,
        processedAt: p.processedAt,
        paidAt: p.paidAt,
        transferReference: p.transferReference,
        estimatedArrivalDate: estimateArrivalDate(p.paidAt),
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async processGatewayRefund(refund: Refund): Promise<Refund> {
    try {
      // Gateway call happens before the transaction opens, so a hung request cannot hold one.
      // If it throws, the outer catch marks the refund FAILED without touching DB state.
      const payment = await this.paymentsRepository.findOne({
        where: { enrollmentId: refund.enrollmentId, status: PaymentStatus.SUCCESS },
        order: { createdAt: 'DESC' },
      });
      if (!payment?.gatewayPaymentId) {
        throw new Error(`No successful payment found for enrollment ${refund.enrollmentId} to refund`);
      }
      const gatewayRefundId =
        payment.gateway === PaymentGateway.PAYU
          ? (await this.payuService.refundTransaction({ mihpayid: payment.gatewayPaymentId, amount: Number(refund.amount) })).refundId
          : `mock_refund_${refund.id}`; // Razorpay path is dormant — no real refund call wired for it yet.

      // Refund status, enrollment status and the capacity decrement must land together —
      // a partial failure previously left slots permanently blocked, starving the waitlist.
      const { savedRefund, ticketTypeId, eventId } = await this.dataSource.transaction(async (manager) => {
        refund.status = RefundStatus.PROCESSED;
        refund.gatewayRefundId = gatewayRefundId;
        refund.processedAt = new Date();
        const savedRefund = await manager.save(Refund, refund);

        const enrollment = await manager.findOne(Enrollment, { where: { id: refund.enrollmentId }, relations: ['event'] });
        await manager.update(Enrollment, refund.enrollmentId, {
          status: 'refunded',
          paymentStatus: 'refunded',
        });

        if (enrollment?.ticketTypeId) {
          await manager.query(
            `UPDATE ticket_types SET quantity_sold = GREATEST(quantity_sold - $1, 0), updated_at = now() WHERE id = $2`,
            [enrollment.quantity, enrollment.ticketTypeId],
          );
        }

        // Reversal must use the SAME split the payment booked, so read the frozen columns:
        // recomputing from live config unbalanced accounts when a rate changed in between.
        const refundOrganizer = enrollment?.event
          ? await manager.findOne(Organizer, { where: { id: enrollment.event.organizerId } })
          : null;
        const refundBreakdown = enrollment
          ? this.resolveBreakdown(
              enrollment,
              enrollment.event ?? { feePayer: FeePayer.ORGANIZER, isPaid: true },
              toCommissionConfig(refundOrganizer),
            )
          : this.feeCalculationService.calculateFromChargedAmount(0, toCommissionConfig(null), FeePayer.ORGANIZER);
        await this.ledgerService.recordRefundLedger(
          manager,
          refund.id,
          refundBreakdown,
          refund.enrollmentId,
          enrollment?.event?.currency || 'INR',
        );

        return { savedRefund, ticketTypeId: enrollment?.ticketTypeId, eventId: enrollment?.eventId };
      });

      this.logger.log(`Refund ${refund.id} processed via gateway (${refund.gatewayRefundId})`);
      await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.PROCESSED, refund.enrollmentId);

      // Same quantitySold change enroll()/cancelEnrollment() invalidate for — a processed
      // refund frees a seat just like a cancellation does.
      if (eventId) {
        await invalidateEventCaches(this.cache, eventId);
      }

      // Capacity is now durably committed — safe to hand the slot to the next FIFO
      // waitlist entry outside the refund's own transaction (promoteNext manages its own).
      if (ticketTypeId) {
        await this.waitlistService.promoteNext(ticketTypeId);
      }
      return savedRefund;
    } catch (err) {
      refund.status = RefundStatus.FAILED;
      const saved = await this.refundsRepository.save(refund);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Refund ${refund.id} gateway call failed: ${message}`);
      await this.notificationService.notifyRefundStatus(refund.requestedBy, refund.id, RefundStatus.FAILED, refund.enrollmentId);
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

  // Webhook idempotency: dedupe gateway retries on gatewayEventId, and wrap ticket
  // issuance + payment confirmation in one transaction.
  async handleWebhook(dto: PaymentWebhookDto): Promise<Payment> {
    const result = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Payment, { where: { gatewayEventId: dto.gatewayEventId } });
      if (existing) {
        this.logger.log(`Duplicate webhook event ${dto.gatewayEventId} ignored (idempotent)`);
        return { payment: existing, confirmedBooking: null };
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
        // Nested transaction so TypeORM issues a real SAVEPOINT — otherwise a unique
        // violation aborts the OUTER transaction and the fallback findOneOrFail throws too.
        savedPayment = await manager.transaction((nested) => nested.save(Payment, payment));
      } catch (err) {
        // Unique-violation race: two concurrent deliveries of the same gateway event both
        // passed the existence check above. Treat the loser as an idempotent duplicate.
        if ((err as { code?: string })?.code === '23505') {
          this.logger.warn(`Race on webhook idempotency key ${dto.gatewayEventId}; returning existing payment`);
          const racedPayment = await manager.findOneOrFail(Payment, { where: { gatewayEventId: dto.gatewayEventId } });
          return { payment: racedPayment, confirmedBooking: null };
        }
        throw err;
      }

      // A late or duplicate webhook can arrive after a refund/cancel. Record the payment
      // for audit, but never resurrect a terminal enrollment.
      let confirmedBooking: {
        userId: string;
        eventId: string;
        enrollmentId: string;
        eventTitle: string;
        bookingReference: string;
        quantity: number;
        ticketCode?: string;
        eventDate: string;
        startTime: string;
        venueName: string;
      } | null = null;
      // Collected inside the transaction but sent after commit — emailing a receipt for a
      // payment that then rolls back is worse than a missing email.
      let issuedInvoice: {
        userId: string;
        invoiceNumber: string;
        enrollmentId: string;
        eventTitle: string;
        lines: InvoiceEmailLine[];
        total: number;
        currency: string;
        transactionId?: string;
      } | null = null;
      if (enrollment.status === 'refunded' || enrollment.status === 'cancelled') {
        this.logger.warn(
          `Webhook ${dto.gatewayEventId} (${dto.status}) received for enrollment ${dto.enrollmentId} which is already "${enrollment.status}"; payment recorded but enrollment left untouched`,
        );
      } else if (dto.status === 'success' && enrollment.paymentStatus === 'paid') {
        // A second genuinely different successful payment (two checkout sheets opened before
        // either resolved). Re-booking would double-count revenue, so log for refund instead.
        this.logger.error(
          `Duplicate successful payment for enrollment ${dto.enrollmentId}: ${dto.gateway} payment ` +
            `${dto.gatewayPaymentId} recorded, but the booking was already paid. The buyer has been ` +
            `charged twice and needs a refund for this payment; no commission or ledger entries were booked for it.`,
        );
      } else if (dto.status === 'success') {
        const organizer = await manager.findOne(Organizer, { where: { id: enrollment.event.organizerId } });
        // calculateFromChargedAmount, not calculate: dto.amount already includes fees under
        // feePayer=PARTICIPANT, so calculate() would apply them a second time.
        const breakdown = this.feeCalculationService.calculateFromChargedAmount(
          dto.amount,
          toCommissionConfig(organizer),
          enrollment.event.feePayer,
          // A free event's charge is the flat registration fee, not a ticket price — see
          // calculateFromChargedAmount's isFreeEvent parameter.
          !enrollment.event.isPaid,
        );

        await manager.save(
          Commission,
          manager.create(Commission, {
            paymentId: savedPayment.id,
            platformCommissionAmount: breakdown.platformCommissionAmount,
            gatewayFeeAmount: breakdown.gatewayFeeAmount,
          }),
        );

        await this.ledgerService.recordPaymentLedger(
          manager,
          savedPayment.id,
          breakdown,
          enrollment.id,
          enrollment.event.currency || 'INR',
        );

        enrollment.status = 'confirmed';
        enrollment.paymentStatus = 'paid';
        // Freeze the split in the same transaction as the ledger legs it must agree with;
        // payout, invoicing and refund reversal read these instead of live config.
        Object.assign(enrollment, toFrozenFeeColumns(breakdown));
        await manager.save(Enrollment, enrollment);

        confirmedBooking = {
          userId: enrollment.userId,
          eventId: enrollment.eventId,
          enrollmentId: enrollment.id,
          eventTitle: enrollment.event.title,
          bookingReference: enrollment.bookingReference,
          quantity: enrollment.quantity,
          ticketCode: enrollment.ticketCode,
          eventDate: enrollment.event.eventDate,
          startTime: enrollment.event.startTime,
          venueName: enrollment.event.venueName,
        };

        issuedInvoice = {
          userId: enrollment.userId,
          // Same number getTaxInvoice() returns, so the emailed receipt and the in-app
          // invoice screen always agree on the identifier.
          invoiceNumber: `INV-${enrollment.bookingReference}`,
          enrollmentId: enrollment.id,
          eventTitle: enrollment.event.title,
          lines: buildInvoiceEmailLines(breakdown),
          total: breakdown.buyerPrice,
          currency: enrollment.event.currency || 'INR',
          transactionId: savedPayment.gatewayPaymentId,
        };
      } else {
        enrollment.paymentStatus = 'failed';
        await manager.save(Enrollment, enrollment);
      }

      this.logger.log(`Processed ${dto.gateway} webhook ${dto.gatewayEventId} for enrollment ${dto.enrollmentId}: ${dto.status}`);
      return { payment: savedPayment, confirmedBooking, issuedInvoice };
    });

    // After commit — a payment succeeding is when a paid booking becomes confirmed.
    // EventsService.enroll() fires the same notification immediately for free bookings.
    if (result.confirmedBooking) {
      const b = result.confirmedBooking;
      void this.notificationService.notifyBookingConfirmed(
        b.userId,
        b.eventId,
        b.enrollmentId,
        b.eventTitle,
        b.bookingReference,
        b.quantity,
        b.ticketCode,
        b.eventDate,
        b.startTime,
        b.venueName,
      );
    }

    // The tax receipt, sent separately from the ticket above — see notifyInvoiceIssued.
    if (result.issuedInvoice) {
      const inv = result.issuedInvoice;
      void this.notificationService.notifyInvoiceIssued(inv.userId, {
        invoiceNumber: inv.invoiceNumber,
        enrollmentId: inv.enrollmentId,
        eventTitle: inv.eventTitle,
        lines: inv.lines,
        total: inv.total,
        currency: inv.currency,
        transactionId: inv.transactionId,
      });
    }

    return result.payment;
  }

  // Payout cron: T+3 after event end, batched per event, excluding enrollments with an
  // open refund dispute.
  @Cron(CronExpression.EVERY_HOUR)
  async runPayoutSweep(): Promise<{ eventsProcessed: number; payoutsCreated: number }> {
    const delayDays = this.configService.get<number>('payout.delayDaysAfterEventEnd', 3);
    const now = new Date();

    // Filtered in SQL, not JS: this previously scanned every event with an unpaid booking,
    // so work grew with open events rather than with events actually due.
    const eligibleEvents = await this.enrollmentsRepository
      .createQueryBuilder('enrollment')
      .select('enrollment.eventId', 'eventId')
      .distinct(true)
      .innerJoin(Event, 'event', 'event.id = enrollment.eventId')
      .where('enrollment.status = :status', { status: 'confirmed' })
      .andWhere('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' })
      .andWhere('enrollment.payoutId IS NULL')
      // A cancelled event must never be swept — its enrollments can still read confirmed/paid,
      // so the organizer would get gross for attendees who were already refunded.
      .andWhere('event.status != :cancelledEvent', { cancelledEvent: EventStatus.CANCELLED })
      .andWhere(
        // Must mirror getEventEndDateTime() exactly. COALESCE picks a multi-day event's LAST
        // day; the IST cast avoids a 5.5h-stricter filter that delayed every payout.
        `((COALESCE(event.event_end_date, event.event_date)::timestamp
             + COALESCE(event.end_time, event.start_time, '00:00')::interval
          ) AT TIME ZONE 'Asia/Kolkata')
           <= (:now::timestamptz - make_interval(days => :delayDays))`,
        { now, delayDays },
      )
      .getRawMany<{ eventId: string }>();

    let payoutsCreated = 0;
    const settled: SettledPayout[] = [];
    for (const { eventId } of eligibleEvents) {
      const event = await this.eventsRepository.findOne({ where: { id: eventId } });
      if (!event) continue;

      // Re-checked in JS via the shared helper so the SQL above stays a pre-filter, not a
      // second definition of "due" that could drift from getEventEndDateTime().
      const eligibleAt = new Date(getEventEndDateTime(event).getTime() + delayDays * 24 * 60 * 60 * 1000);
      if (now < eligibleAt) continue;

      const result = await this.settleEventPayout(event);
      if (result) {
        payoutsCreated++;
        settled.push(result);
      }
    }

    // Sent only after each payout's own transaction has committed.
    for (const payout of settled) {
      void this.notificationService.notifyPayoutProcessed(payout.organizerUserId, {
        payoutId: payout.payoutId,
        eventId: payout.eventId,
        eventTitle: payout.eventTitle,
        ticketCount: payout.ticketCount,
        grossRevenue: payout.grossRevenue,
        platformFee: payout.platformFee,
        gatewayFee: payout.gatewayFee,
        payoutAmount: payout.payoutAmount,
      });
    }

    this.logger.log(`Payout sweep: ${payoutsCreated} payout(s) created across ${eligibleEvents.length} due event(s)`);
    return { eventsProcessed: eligibleEvents.length, payoutsCreated };
  }

  // THE reader for how a booking was split — payout, invoice and refund reversal all use it.
  // Frozen columns win; recomputation is a lossy fallback for pre-freeze rows only.
  private resolveBreakdown(
    enrollment: Enrollment,
    event: Pick<Event, 'feePayer' | 'isPaid'>,
    organizer: OrganizerCommissionConfig,
  ): FeeBreakdown {
    const frozen = readFrozenBreakdown(enrollment);
    if (frozen) return frozen;

    this.logger.debug(
      `Enrollment ${enrollment.id} has no frozen fee split (booked before the freeze); recomputing from current rates`,
    );
    return this.feeCalculationService.calculateFromChargedAmount(
      Number(enrollment.totalAmount),
      organizer,
      event.feePayer,
      !event.isPaid,
    );
  }

  // Reconciles PER BOOKING, not just the total: two equal-and-opposite errors sum to a
  // matching total. Pre-ledger rows are excluded, since 0 would block them forever.
  private async reconcilePayoutAgainstLedger(
    manager: EntityManager,
    // Takes already-resolved payouts, not enrollments: re-deriving them would compare the
    // ledger against a second computation and diverge for every negotiated commission rate.
    expectedByEnrollment: { enrollmentId: string; expected: number }[],
    bookingTotal: number,
  ): Promise<{
    matches: boolean;
    ledgerTotal: number;
    reconciledCount: number;
    unledgeredCount: number;
    divergences: { enrollmentId: string; expected: number; actual: number }[];
  }> {
    const ledgerByEnrollment = await this.ledgerService.getOrganizerPayableByEnrollment(
      manager,
      expectedByEnrollment.map((e) => e.enrollmentId),
    );

    let ledgerTotal = 0;
    let unledgeredTotal = 0;
    let unledgeredCount = 0;
    const divergences: { enrollmentId: string; expected: number; actual: number }[] = [];

    for (const { enrollmentId, expected } of expectedByEnrollment) {
      if (!ledgerByEnrollment.has(enrollmentId)) {
        unledgeredCount++;
        unledgeredTotal = round2(unledgeredTotal + expected);
        continue;
      }

      const actual = ledgerByEnrollment.get(enrollmentId)!;
      ledgerTotal = round2(ledgerTotal + actual);
      // Exact equality in paise — both sides are the same rupee figure rounded to 2dp, so a
      // tolerance would only hide real divergences.
      if (Math.round(expected * 100) !== Math.round(actual * 100)) {
        divergences.push({ enrollmentId, expected, actual });
      }
    }

    // The ledger side is only responsible for the reconcilable bookings, so the booking side
    // is compared net of the unledgered ones it cannot speak to.
    const comparableBookingTotal = round2(bookingTotal - unledgeredTotal);
    const matches =
      divergences.length === 0 && Math.round(comparableBookingTotal * 100) === Math.round(ledgerTotal * 100);

    return {
      matches,
      ledgerTotal,
      reconciledCount: expectedByEnrollment.length - unledgeredCount,
      unledgeredCount,
      divergences,
    };
  }

  private async settleEventPayout(event: Event): Promise<SettledPayout | null> {
    return this.dataSource.transaction(async (manager) => {
      // Re-read status INSIDE the transaction: an organizer cancelling after the pre-filter
      // ran would otherwise still be paid.
      const currentStatus = await manager.findOne(Event, {
        where: { id: event.id },
        select: { id: true, status: true },
      });
      if (!currentStatus || currentStatus.status === EventStatus.CANCELLED) {
        this.logger.warn(
          `Skipping payout for event ${event.id}: event is ${currentStatus?.status ?? 'missing'} at settlement time`,
        );
        return null;
      }

      // Row-lock so a concurrent sweep can't double-pay. NOT EXISTS rather than LEFT JOIN
      // because Postgres refuses FOR UPDATE across the nullable side of an outer join.
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

      if (!enrollments.length) return null;

      // Re-checked with the locks held: requestRefund() takes its own lock on the same row,
      // so this closes the race rather than relying on lock-wait timing.
      const enrollmentIds = enrollments.map((e) => e.id);
      const openRefundEnrollmentIds = new Set(
        (
          await manager.find(Refund, {
            where: { enrollmentId: In(enrollmentIds), status: In([RefundStatus.REQUESTED, RefundStatus.APPROVED]) },
          })
        ).map((r) => r.enrollmentId),
      );
      const payableEnrollments = openRefundEnrollmentIds.size
        ? enrollments.filter((e) => !openRefundEnrollmentIds.has(e.id))
        : enrollments;
      if (!payableEnrollments.length) return null;

      const organizer = await manager.findOne(Organizer, { where: { id: event.organizerId } });
      if (!organizer) {
        this.logger.error(`Skipping payout for event ${event.id}: organizer ${event.organizerId} not found`);
        return null;
      }

      const commissionConfig: OrganizerCommissionConfig = toCommissionConfig(organizer);

      // Accumulated per-fee so the settlement email shows the breakdown the payout came from,
      // and so reconciliation compares against these figures rather than re-resolving.
      const totals = { payout: 0, gross: 0, platformFee: 0, gatewayFee: 0 };
      const expectedByEnrollment: { enrollmentId: string; expected: number }[] = [];
      for (const enrollment of payableEnrollments) {
        // Frozen-first: the organizer is paid what was computed AT PAYMENT TIME, so a rate
        // edited before T+3 cannot change what is owed for tickets already sold.
        const breakdown = this.resolveBreakdown(enrollment, event, commissionConfig);
        totals.payout += breakdown.organizerPayout;
        totals.gross += breakdown.buyerPrice;
        totals.platformFee += breakdown.platformCommissionAmount;
        totals.gatewayFee += breakdown.gatewayFeeAmount;
        expectedByEnrollment.push({ enrollmentId: enrollment.id, expected: round2(breakdown.organizerPayout) });
      }
      const totalPayout = round2(totals.payout);

      // The ledger must independently agree before money is payable. On a mismatch neither
      // side can be trusted, so abort — the next sweep retries once the divergence is fixed.
      const reconciliation = await this.reconcilePayoutAgainstLedger(manager, expectedByEnrollment, totalPayout);
      if (!reconciliation.matches) {
        this.logger.error(
          `PAYOUT BLOCKED — ledger disagreement for event ${event.id} (organizer ${event.organizerId}): ` +
            `bookings say ${totalPayout}, ledger says ${reconciliation.ledgerTotal} ` +
            `(difference ${round2(totalPayout - reconciliation.ledgerTotal)}) across ` +
            `${reconciliation.reconciledCount} reconcilable booking(s). ` +
            `Per-booking divergences: ${reconciliation.divergences
              .map((d) => `${d.enrollmentId} booked=${d.expected} ledger=${d.actual}`)
              .join('; ')}. ` +
            `No payout row was created; this event will be retried on the next sweep.`,
        );
        return null;
      }
      if (reconciliation.unledgeredCount) {
        // Not a failure: bookings that predate the ledger have nothing to reconcile against.
        // Logged so the size of that population is visible rather than silently trusted.
        this.logger.warn(
          `Event ${event.id}: ${reconciliation.unledgeredCount} of ${payableEnrollments.length} booking(s) ` +
            `have no ledger entries (pre-ledger bookings) and were paid out unreconciled`,
        );
      }

      const payout = manager.create(Payout, {
        organizerId: event.organizerId,
        eventId: event.id,
        ticketCount: payableEnrollments.length,
        amount: Math.round(totalPayout * 100) / 100,
        currency: event.currency,
        // PENDING + processedAt, never PAID. The sweep computes an obligation; no transfer
        // has happened. markPayoutPaid() is the only thing that may set PAID.
        status: PayoutStatus.PENDING,
        processedAt: new Date(),
      });
      const savedPayout = await manager.save(Payout, payout);

      await manager.update(
        Enrollment,
        payableEnrollments.map((e) => e.id),
        { payoutId: savedPayout.id },
      );

      await this.ledgerService.recordPayoutLedger(
        manager,
        savedPayout.id,
        savedPayout.amount,
        event.id,
        event.currency || 'INR',
      );

      this.logger.log(
        `Payout ${savedPayout.id} created for event ${event.id} (organizer ${event.organizerId}): ` +
          `${payableEnrollments.length} ticket(s), ${savedPayout.currency} ${savedPayout.amount}`,
      );
      // Returned rather than emailed here: the caller notifies only once this transaction
      // has committed, so an organizer is never told about a payout that then rolls back.
      return {
        organizerUserId: organizer.userId,
        payoutId: savedPayout.id,
        eventId: event.id,
        eventTitle: event.title,
        ticketCount: payableEnrollments.length,
        grossRevenue: round2(totals.gross),
        platformFee: round2(totals.platformFee),
        gatewayFee: round2(totals.gatewayFee),
        payoutAmount: savedPayout.amount,
      };
    });
  }

  // The only path to PAID — call only on a CONFIRMED transfer, since this sets paid_at.
  // Idempotent so a duplicate provider webhook cannot re-stamp or re-notify.
  async markPayoutPaid(payoutId: string, transferReference?: string, notes?: string): Promise<Payout> {
    // Relations loaded for the notification below
    const payout = await this.payoutsRepository.findOne({
      where: { id: payoutId },
      relations: ['organizer', 'event'],
    });
    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);
    if (payout.status === PayoutStatus.PAID) return payout;
    if (payout.status !== PayoutStatus.PENDING) {
      throw new BadRequestException(`Payout ${payoutId} is ${payout.status} and cannot be marked paid`);
    }

    payout.status = PayoutStatus.PAID;
    payout.paidAt = new Date();
    if (transferReference) payout.transferReference = transferReference;
    if (notes) payout.notes = notes;
    const saved = await this.payoutsRepository.save(payout);
    this.logger.log(
      `Payout ${payoutId} marked PAID${transferReference ? ` (transfer ${transferReference})` : ''}`,
    );

    // After the write: a failed notification must not roll back a real settlement
    if (payout.organizer?.userId) {
      // try/catch, not .catch(): a sync throw would escape and unwind a settlement
      // that already happened at the bank.
      try {
        await this.notificationService.notifyPayoutPaid(payout.organizer.userId, {
          payoutId: saved.id,
          eventId: saved.eventId,
          eventTitle: payout.event?.title ?? 'your event',
          payoutAmount: Number(saved.amount),
          transferReference: saved.transferReference,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to notify organizer of paid payout ${payoutId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      this.logger.warn(`Payout ${payoutId} marked PAID but organizer relation was missing; no notification sent`);
    }

    return saved;
  }

  // Flat GST-invoice projection of a settled booking, shared by both invoice UIs.
  // Under feePayer=ORGANIZER the buyer paid only the ticket price, so fee lines report 0.
  async getTaxInvoice(userId: string, enrollmentId: string) {
    const { enrollment, payment, breakdown } = await this.loadInvoiceContext(userId, enrollmentId);
    // A free booking's platform fee is an organizer receivable, never a buyer charge, so it
    // must not appear on their invoice.
    const buyerPaidFees = breakdown.feePayer === FeePayer.PARTICIPANT && breakdown.buyerPrice > 0;
    const quantity = enrollment.quantity || 1;

    return {
      invoiceNumber: `INV-${enrollment.bookingReference}`,
      invoiceDate: payment?.createdAt || enrollment.createdAt,
      enrollmentId: enrollment.id,
      bookingReference: enrollment.bookingReference,
      eventTitle: enrollment.event.title,
      eventDate: enrollment.event.eventDate,
      venueName: enrollment.event.venueName,
      ticketTypeName: enrollment.ticketType?.name || 'Standard Entry',
      quantity,
      // breakdown.ticketPrice is the base across the whole order, so divide back out.
      unitPrice: this.roundMoney(breakdown.ticketPrice / quantity),
      subtotalBeforeTax: buyerPaidFees ? breakdown.subtotalBeforeTax : breakdown.buyerPrice,
      gstRate: this.configService.get<number>('tax.gstRate', 0),
      gstAmount: buyerPaidFees ? breakdown.gstAmount : 0,
      // Commission and gateway fee are one "platform fee" line to the buyer — the split
      // between what the platform keeps and what the gateway takes is not their concern.
      platformFeeAmount: buyerPaidFees
        ? this.roundMoney(breakdown.platformCommissionAmount + breakdown.gatewayFeeAmount)
        : 0,
      totalAmountPaid: breakdown.buyerPrice,
      buyerName: enrollment.user.fullName,
      buyerEmail: enrollment.user.email,
      organizerName: enrollment.event.organizer?.companyName || 'Eventrix Host',
      // Undefined for an organizer below the GST registration threshold — the invoice omits
      // the line rather than printing an empty field.
      organizerGstin: enrollment.event.organizer?.gstin || undefined,
    };
  }

  // Shared loader for both invoice shapes — duplicating ownership and paid-status checks
  // risks the two views disagreeing about who may see what.
  private async loadInvoiceContext(userId: string, enrollmentId: string) {
    const enrollment = await this.enrollmentsRepository.findOne({
      where: { id: enrollmentId },
      relations: ['event', 'event.organizer', 'ticketType', 'user'],
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.userId !== userId) {
      throw new ForbiddenException('You can only view tax invoices for your own bookings');
    }
    if (enrollment.paymentStatus !== 'paid') {
      throw new BadRequestException('Invoice is only available for paid bookings');
    }

    const payment = await this.paymentsRepository.findOne({
      where: { enrollmentId: enrollment.id, status: PaymentStatus.SUCCESS },
    });

    // Frozen-first: an invoice must reproduce the numbers the buyer was billed, forever.
    const breakdown = this.resolveBreakdown(
      enrollment,
      enrollment.event,
      toCommissionConfig(enrollment.event.organizer),
    );

    return { enrollment, payment, breakdown };
  }

}

// What settleEventPayout hands back so runPayoutSweep can notify the organizer once the
// payout's transaction has actually committed.
interface SettledPayout {
  organizerUserId: string;
  payoutId: string;
  eventId: string;
  eventTitle: string;
  ticketCount: number;
  grossRevenue: number;
  platformFee: number;
  gatewayFee: number;
  payoutAmount: number;
}

// One row of an organizer's own settlement history (GET /payments/my-payouts).
export interface OrganizerPayoutView {
  id: string;
  eventId: string;
  eventTitle: string;
  eventDate?: string;
  eventCoverImageUrl?: string;
  ticketCount: number;
  amount: number;
  currency: string;
  status: PayoutStatus;
  // When the sweep computed the obligation.
  processedAt?: Date;
  // When a transfer was confirmed. Null on everything that has not actually been sent.
  paidAt?: Date;
  transferReference?: string;
  estimatedArrivalDate?: Date;
}

// Only for sent payouts — a date on a PENDING one would read as a promise.
// Two working days is the slow end of NEFT; holidays are not modelled, hence "estimate".
function estimateArrivalDate(paidAt?: Date): Date | undefined {
  if (!paidAt) return undefined;
  const date = new Date(paidAt);
  let added = 0;
  while (added < 2) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return date;
}

// PayU rejects anything but 10 digits, from native code, so the cause never reaches our logs.
// Normalised because Edit Profile stores unvalidated input; phone is not part of the hash.
export function toPayuPhone(raw: string | null | undefined): string {
  const subscriber = toTenDigitMobile(raw);

  if (!subscriber) {
    throw new BadRequestException(
      'A 10-digit mobile number is required to pay. Add one to your profile and try again.',
    );
  }
  return subscriber;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Fee lines appear ONLY when the participant actually paid them. Under feePayer=ORGANIZER
// itemising platform/gateway/GST would state charges the buyer never incurred.
function buildInvoiceEmailLines(breakdown: FeeBreakdown): InvoiceEmailLine[] {
  const lines: InvoiceEmailLine[] = [{ label: 'Ticket price', amount: breakdown.ticketPrice }];
  // buyerPrice > 0 excludes free bookings, whose platform fee is billed to the organizer.
  if (breakdown.feePayer !== FeePayer.PARTICIPANT || breakdown.buyerPrice <= 0) return lines;

  if (breakdown.platformCommissionAmount > 0) {
    lines.push({ label: 'Platform fee', amount: breakdown.platformCommissionAmount });
  }
  if (breakdown.gatewayFeeAmount > 0) {
    lines.push({ label: 'Payment gateway fee', amount: breakdown.gatewayFeeAmount });
  }
  if (breakdown.gstAmount > 0) {
    // Rate derived, never hardcoded — TAX_GST_RATE is configurable and an "18%" label would
    // become a lie the moment it changes.
    const rate = Math.round((breakdown.gstAmount / breakdown.platformCommissionAmount) * 10000) / 100;
    lines.push({
      label: Number.isFinite(rate) && rate > 0 ? `GST (${rate}% on platform fee)` : 'GST on platform fee',
      amount: breakdown.gstAmount,
    });
  }
  return lines;
}

// From PayuUtils.isValidTxnId (decompiled, undocumented): non-blank, <=25 chars, alphanumeric.
// Violations are rejected on-device as "InValid transactionId" with no server-side signal.
const PAYU_MAX_TXNID_LENGTH = 25;

// Leading hex chars of the enrollment uuid carried by every txnid, so any attempt traces
// back to its booking. The minting and decoding sides must agree on this.
const ENROLLMENT_ID_PREFIX_LENGTH = 17;

// Fails at mint time: PayU's check runs on-device and leaves no server-side trace,
// so a format change would otherwise silently stop bookings being payable.
export function assertValidPayUTxnId(txnid: string): void {
  if (txnid.length > PAYU_MAX_TXNID_LENGTH || !/^[a-zA-Z0-9]+$/.test(txnid)) {
    throw new Error(
      `Generated PayU txnid "${txnid}" (${txnid.length} chars) violates PayU's rule ` +
        `(max ${PAYU_MAX_TXNID_LENGTH} chars, alphanumeric only). Checkout would fail on the device.`,
    );
  }
}

// PayU's hash format is pipe-delimited — see the comment at initiatePayUOrder's call site.
function sanitizePayUField(value: string): string {
  return value.replace(/\|/g, '-');
}
