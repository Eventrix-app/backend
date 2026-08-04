import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Event, FeePayer } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { Organizer } from '../entities/organizer.entity';
import { User } from '../entities/user.entity';
import { Payment, PaymentGateway, PaymentStatus } from '../entities/payment.entity';
import { Commission } from '../entities/commission.entity';
import { Refund, RefundStatus } from '../entities/refund.entity';
import { Payout, PayoutStatus } from '../entities/payout.entity';
import { FeeCalculationService, FeeBreakdown, OrganizerCommissionConfig } from './fee-calculation.service';
import type { InvoiceEmailLine } from '../email/templates';
import { RazorpayService } from './razorpay.service';
import { PayUService } from './payu.service';
import { LedgerService } from './ledger.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { NotificationService } from '../notifications/notification.service';
import { FeeEstimateDto } from './dto/fee-estimate.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { InitiatePayUOrderDto } from './dto/initiate-payu-order.dto';
import { PayUReturnDto } from './dto/payu-return.dto';
import { getEventStartDateTime, getEventEndDateTime } from '../events/utils/event-dates.util';
import { invalidateEventCaches } from '../events/utils/event-cache.util';
import { CacheService } from '../common/cache/cache.service';

// Same leak EventsService's SAFE_ENROLLMENT_USER_SELECT guards against — Enrollment.user is a
// plain ManyToOne to the full User entity (passwordHash included), so the organizer refund
// queue must scope it too. Event/user context is eager-loaded (rather than left for the client
// to separately look up) so the approval screen can show what it's approving.
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

  // ---------------------------------------------------------------------
  // Real-money checkout: create-order (before the gateway sheet opens) ->
  // client-side verify (right after it reports success) -> handleWebhook.
  // verifyPayment and the async gateway webhook both funnel into the exact
  // same handleWebhook() below, keyed off the same gatewayEventId (the
  // Razorpay payment id), so whichever arrives first confirms the booking
  // and the other is a no-op idempotent duplicate.
  // ---------------------------------------------------------------------
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

    // The signature only proves (orderId, paymentId) is a genuine Razorpay pair — it says
    // nothing about which enrollment that order was created for. Without this check, a user
    // could pay a trivial order for an enrollment they own, then replay the resulting valid
    // signed triple against a different (more expensive) enrollment of theirs. notes.
    // enrollmentId and amount are both set server-side at createOrder() time and never
    // client-controlled, so cross-checking against them closes that gap.
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

  // ---------------------------------------------------------------------
  // PayU checkout — the active gateway (Razorpay above is kept working but
  // dormant). Structurally different from Razorpay's API-order + client-SDK
  // flow: our server mints a txnid + hash, the client POSTs a hidden form
  // straight to PayU's hosted page, and PayU redirects that same
  // browser/WebView session to whichever of surl/furl matches the outcome —
  // handled by handlePayUReturn below, which funnels into the same
  // gateway-agnostic handleWebhook() Razorpay's path already uses.
  // ---------------------------------------------------------------------
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
      phone: user.phoneNumber || '',
      key: this.payuService.merchantKey,
      hash,
      actionUrl: this.payuService.actionUrl,
    };
  }

  // Native SDK (payu-non-seam-less-react) checkout — same enrollment/txnid setup as the
  // WebView flow above, but no pre-computed hash is returned: the SDK requests hashes on
  // demand via its own generateHash callback (see PayUService.signHash), so the app only
  // needs the raw fields to build payUPaymentParams. Field names here match the SDK's own
  // camelCase convention (productInfo/firstName), not the classic flow's lowercase one —
  // confirmed by reading payu-non-seam-less-react's native source directly.
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
      phone: user.phoneNumber || '',
      // "1" = test mode, "0" = production, per PayUBizConstants.ENVIRONMENT — a string, not a
      // boolean, matching the SDK's own native constant type.
      environment: this.payuService.isTestMode ? '1' : '0',
    };
  }

  // Shared by both the WebView and native PayU initiation paths: ownership/pending-status/
  // amount validation, minting a fresh unique txnid, persisting it on the enrollment (so
  // handlePayUReturn/verify-native can look the attempt back up), and sanitizing the
  // free-text fields PayU's pipe-delimited hash formula is sensitive to.
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

    // PayU requires a fresh, unique txnid per attempt (a user retrying a failed/abandoned
    // payment must not reuse one PayU has already seen) — enrollment id + a base36 timestamp
    // keeps it short and alphanumeric-only. The mapping back to this enrollment is stored on
    // the enrollment itself (payuTxnId) rather than encoded into the txnid string, since
    // PayU's classic flow has no "fetch order by id" API to round-trip through the way
    // Razorpay's fetchOrder() does.
    // The enrollment-id prefix is not cosmetic: resolveEnrollmentForTxnid() decodes it to
    // recover the booking when a late callback arrives for an attempt this one supersedes.
    // Changing this format without changing that decoder reintroduces silent payment loss.
    const txnid = `${enrollment.id.replace(/-/g, '').slice(0, ENROLLMENT_ID_PREFIX_LENGTH)}${Date.now().toString(36)}`;
    await this.enrollmentsRepository.update(enrollment.id, { payuTxnId: txnid });

    // PayU's hash uses `|` as the field delimiter — a literal pipe inside a free-text field
    // (an event titled "VIP | Backstage Pass", or a user's name) would silently shift every
    // field after it, making the hash structurally diverge from what PayU computes on their
    // end. Stripped here rather than escaped, since whatever we send is echoed back verbatim
    // in the reverse-hash callback and must match byte-for-byte either way.
    const amount = Number(enrollment.totalAmount);
    const productinfo = sanitizePayUField(enrollment.event.title).slice(0, 100);
    const firstname = sanitizePayUField((user.fullName || 'Guest').split(' ')[0]).slice(0, 60);
    const email = user.email;

    return { enrollment, user, txnid, amount, productinfo, firstname, email };
  }

  // Resolves the enrollment a PayU callback belongs to, including for a SUPERSEDED attempt.
  //
  // PayU requires a unique txnid per attempt, so every retry mints a new one and overwrites
  // enrollment.payuTxnId (reusing a txnid PayU has already seen is rejected, which would
  // break retry entirely — so "just don't overwrite it" is not an available fix). That left
  // the column holding only the LATEST attempt: if a user abandoned attempt A, retried as B,
  // and A then completed late — an async UPI collect approved after the fact, a delayed
  // netbanking return, or PayU retrying surl server-side — the callback for A matched nothing
  // and the payment was silently lost, with the buyer charged and no booking to show for it.
  //
  // No extra column or table is needed to fix it, because the txnid already carries the
  // answer: it is built as <first 20 hex chars of the enrollment uuid><base36 timestamp>
  // (see resolvePendingPayUAttempt). Any attempt, current or superseded, therefore names its
  // own enrollment. The exact-match lookup stays first since it is the indexed common path;
  // the prefix decode is the fallback.
  //
  // This widens only WHICH enrollment is found — every existing check still runs against it
  // afterwards (reverse-hash, amount, and the caller-ownership check on the native path), so
  // resolving a superseded attempt is no weaker than resolving the current one.
  private async resolveEnrollmentForTxnid(txnid: string): Promise<Enrollment | null> {
    const exact = await this.enrollmentsRepository.findOne({
      where: { payuTxnId: txnid },
      relations: ['event'],
    });
    if (exact) return exact;

    // Only a well-formed prefix is ever fed to the LIKE below — the id fragment is hex by
    // construction, so anything else is not one of our txnids and must not reach the query.
    const prefix = txnid.slice(0, ENROLLMENT_ID_PREFIX_LENGTH).toLowerCase();
    if (!/^[0-9a-f]{20}$/.test(prefix)) return null;

    const matches = await this.enrollmentsRepository
      .createQueryBuilder('enrollment')
      .leftJoinAndSelect('enrollment.event', 'event')
      .where(`REPLACE(enrollment.id::text, '-', '') LIKE :prefix`, { prefix: `${prefix}%` })
      .limit(2)
      .getMany();

    // 80 bits of uuid make a collision negligible, but guessing between two bookings would
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

  // Called by PaymentsController's /payu/sign-hash route — the native SDK's generateHash
  // callback hands the app a raw string it needs signed; the salt must never leave the
  // server, so this is the one seam that crosses that boundary. Generic on purpose: it works
  // for whatever hash type the SDK ever asks for (see PayUService.signHash's own comment).
  signPayUHash(hashString: string): string {
    return this.payuService.signHash(hashString);
  }

  // Called by PaymentsController's /payu/return route for both surl and furl — dto.status
  // distinguishes success from failure. Never allowed to throw past the controller (which
  // wraps this in its own try/catch): a WebView stuck on a bare JSON error page has no way
  // to close itself, unlike a normal API error an app can retry.
  //
  // callerUserId: when provided (native SDK's /payu/verify-native path, which is JWT-
  // authenticated), the enrollment's owner must match this id — prevents a user who knows
  // another user's txnid from confirming a booking they never paid for. Absent for the
  // unauthenticated browser-redirect path (/payu/return), where the reverse-hash is the
  // only authentication layer.
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

  // ---------------------------------------------------------------------
  // Fee calculation — standalone endpoint, callable from the Create Event
  // flow before the event is ever submitted for admin approval.
  // ---------------------------------------------------------------------
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
    // Locks the enrollment row for the duration of the "any open refund already exists?"
    // check plus the insert — without this, two near-simultaneous requests (double-tap,
    // client retry) can both pass the existence check before either commits, producing two
    // REQUESTED rows for one booking that can then each be independently approved and
    // double-processed (double capacity release, eventually double gateway refunds).
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
    // Second half of the same event: the acknowledgement above goes to the participant, this
    // one puts the request in front of whoever has to decide it. Fire-and-forget — the refund
    // row is already committed and must not be rolled back over a notification failure.
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

    // Row-locked transition: without this, two concurrent approve calls (double-click, two
    // organizer/admin tabs) can both read status REQUESTED, both pass canTransition, and both
    // proceed to processGatewayRefund — double-decrementing ticket capacity and
    // double-promoting the waitlist. Mirrors the same pessimistic_write pattern already used
    // by tryPromote and settleEventPayout for the identical class of race.
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

  // General-purpose admin listing over every payment (not just pending refunds) — no
  // listing method existed on paymentsRepository before this; joins through Enrollment for
  // event/user context using the same field allowlist REFUND_SAFE_ENROLLMENT_SELECT already
  // guards for refunds, so a payment row never leaks the enrollment user's passwordHash.
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

  private async processGatewayRefund(refund: Refund): Promise<Refund> {
    try {
      // The real gateway call happens before the transaction opens — a slow/hung external
      // request shouldn't hold a DB transaction open, and if PayU's API fails/throws, the
      // outer catch below marks the refund FAILED without ever touching the DB state below.
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

      // Refund status, enrollment status, and the ticket-type capacity decrement must
      // land together — a partial failure here previously could leave an enrollment
      // marked "refunded" while ticket_types.quantity_sold never freed up (permanently
      // blocking a slot and starving the waitlist), or the reverse.
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

        // Reversing the fee legs needs the same split the payment booked, so the breakdown is
        // recomputed from the charged amount rather than only the gross being reversed.
        // Recomputed (not read back from the Commission row) because that row has no GST
        // column — mixing a stored commission with a recomputed GST would be inconsistent,
        // and the codebase already accepts recompute-from-current-config as the model here.
        // The caveat is the known one: if rates changed between payment and refund, the
        // reversal won't exactly cancel the original legs.
        const refundOrganizer = enrollment?.event
          ? await manager.findOne(Organizer, { where: { id: enrollment.event.organizerId } })
          : null;
        const refundBreakdown = this.feeCalculationService.calculateFromChargedAmount(
          Number(enrollment?.totalAmount || 0),
          {
            commissionRate: Number(refundOrganizer?.commissionRate ?? 0),
            commissionFlatFee: Number(refundOrganizer?.commissionFlatFee ?? 0),
          },
          enrollment?.event?.feePayer ?? FeePayer.ORGANIZER,
        );
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

  // ---------------------------------------------------------------------
  // Payment webhook idempotency: dedupe gateway retries on gatewayEventId,
  // wrap ticket issuance + payment confirmation in one transaction.
  // ---------------------------------------------------------------------
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
        // Wrapped in a nested manager.transaction() rather than a plain manager.save() —
        // TypeORM issues a real Postgres SAVEPOINT for a transaction started on an
        // already-transactional manager (see PostgresQueryRunner's transactionDepth
        // handling). Without it, a unique-violation here leaves the *outer* transaction
        // aborted (Postgres error 25P02), so the fallback findOneOrFail below would itself
        // throw instead of gracefully returning the winner's row.
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

      // A late or duplicate-gateway-retry webhook can arrive after the enrollment has
      // already been refunded/cancelled through a separate flow. Record the payment for
      // the audit trail either way, but never let it resurrect a terminal enrollment.
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
      // Collected inside the transaction (it needs the breakdown computed below) but sent
      // only after it commits, same as confirmedBooking — emailing a receipt for a payment
      // whose transaction then rolls back would be worse than a missing email.
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
      } else if (dto.status === 'success') {
        const organizer = await manager.findOne(Organizer, { where: { id: enrollment.event.organizerId } });
        // calculateFromChargedAmount, NOT calculate: dto.amount is the amount actually
        // charged, which under feePayer=PARTICIPANT already includes commission + gateway
        // fee + GST (enroll() persists breakdown.buyerPrice as totalAmount). Passing it to
        // calculate() would apply all three a second time, inflating the Commission row and
        // every ledger entry below it.
        const breakdown = this.feeCalculationService.calculateFromChargedAmount(
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

        await this.ledgerService.recordPaymentLedger(
          manager,
          savedPayment.id,
          breakdown,
          enrollment.id,
          enrollment.event.currency || 'INR',
        );

        enrollment.status = 'confirmed';
        enrollment.paymentStatus = 'paid';
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
          // Same number getInvoiceData() returns, so the emailed receipt and the in-app
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

    // Fired after the transaction commits — a payment succeeding is exactly the moment a
    // paid booking becomes actually confirmed-and-paid (see EventsService.enroll(), which
    // fires the same notification immediately for free bookings instead).
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

  // ---------------------------------------------------------------------
  // Payout cron: T+3 days after event end, batched per event, excluding
  // enrollments with an open (requested/approved) refund dispute.
  // ---------------------------------------------------------------------
  @Cron(CronExpression.EVERY_HOUR)
  async runPayoutSweep(): Promise<{ eventsProcessed: number; payoutsCreated: number }> {
    const delayDays = this.configService.get<number>('payout.delayDaysAfterEventEnd', 3);
    const now = new Date();

    // Eligibility is filtered in SQL, not in JS. Previously this selected EVERY event with
    // an unpaid confirmed enrollment — no date predicate at all — then issued one findOne per
    // candidate and discarded the ones not yet due. On an hourly cron that meant the work
    // grew with the number of open events (including ones months in the future) rather than
    // with the number actually due.
    //
    // The end timestamp is composed the same way getEventEndDateTime() does it: end_time when
    // present, otherwise start_time, falling back to midnight — kept in one SQL expression so
    // the join can be a single indexed scan. The JS re-check below remains the authority for
    // the exact boundary; this predicate only has to be no stricter than it.
    const eligibleEvents = await this.enrollmentsRepository
      .createQueryBuilder('enrollment')
      .select('enrollment.eventId', 'eventId')
      .distinct(true)
      .innerJoin(Event, 'event', 'event.id = enrollment.eventId')
      .where('enrollment.status = :status', { status: 'confirmed' })
      .andWhere('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' })
      .andWhere('enrollment.payoutId IS NULL')
      .andWhere(
        `(event.event_date::timestamp + COALESCE(event.end_time, event.start_time, '00:00')::interval)
           <= (:now::timestamp - make_interval(days => :delayDays))`,
        { now, delayDays },
      )
      .getRawMany<{ eventId: string }>();

    let payoutsCreated = 0;
    const settled: SettledPayout[] = [];
    for (const { eventId } of eligibleEvents) {
      const event = await this.eventsRepository.findOne({ where: { id: eventId } });
      if (!event) continue;

      // Re-checked in JS against the same helper the rest of the codebase uses, so the SQL
      // predicate above is a pre-filter rather than a second, subtly-different definition of
      // "due" that could drift from getEventEndDateTime().
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

  private async settleEventPayout(event: Event): Promise<SettledPayout | null> {
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

      if (!enrollments.length) return null;

      // Explicit re-check rather than trusting the NOT EXISTS subquery above to still hold
      // once the FOR UPDATE locks are actually granted — requestRefund() takes its own
      // pessimistic_write lock on the same enrollment row (see its own comment), so a
      // refund request racing this sweep either fully commits before this point or blocks
      // until this transaction ends. Re-querying now, with the locks already held, is what
      // actually closes that window rather than relying on lock-wait timing alone.
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

      const commissionConfig: OrganizerCommissionConfig = {
        commissionRate: Number(organizer.commissionRate),
        commissionFlatFee: Number(organizer.commissionFlatFee),
      };

      // Totals are accumulated per-fee (not just the payout) so the organizer's settlement
      // email can show the same breakdown the payout was actually derived from, rather than
      // recomputing it from a rounded aggregate afterwards.
      const totals = payableEnrollments.reduce(
        (acc, enrollment) => {
          // enrollment.totalAmount is what the buyer was charged, not the bare ticket price —
          // under feePayer=PARTICIPANT it already includes the fees. calculate() would treat
          // it as a base price and return organizerPayout === totalAmount, paying the
          // organizer the platform's own commission and the gateway fee along with it.
          const breakdown = this.feeCalculationService.calculateFromChargedAmount(
            Number(enrollment.totalAmount),
            commissionConfig,
            event.feePayer,
          );
          return {
            payout: acc.payout + breakdown.organizerPayout,
            gross: acc.gross + breakdown.buyerPrice,
            platformFee: acc.platformFee + breakdown.platformCommissionAmount,
            gatewayFee: acc.gatewayFee + breakdown.gatewayFeeAmount,
          };
        },
        { payout: 0, gross: 0, platformFee: 0, gatewayFee: 0 },
      );
      const totalPayout = totals.payout;

      const payout = manager.create(Payout, {
        organizerId: event.organizerId,
        eventId: event.id,
        ticketCount: payableEnrollments.length,
        amount: Math.round(totalPayout * 100) / 100,
        currency: event.currency,
        status: PayoutStatus.PAID,
        paidAt: new Date(),
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

  async getInvoiceData(userId: string, enrollmentId: string) {
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

    // Same reason as handleWebhook/settleEventPayout: totalAmount is the charged amount, so
    // it must be split, not re-marked-up. Using calculate() here printed an invoice whose
    // "total" exceeded what the buyer was actually billed — a tax document stating an
    // amount that was never charged.
    const breakdown = this.feeCalculationService.calculateFromChargedAmount(
      Number(enrollment.totalAmount),
      {
        commissionRate: Number(enrollment.event.organizer?.commissionRate ?? 0),
        commissionFlatFee: Number(enrollment.event.organizer?.commissionFlatFee ?? 0),
      },
      enrollment.event.feePayer,
    );

    return {
      invoiceNumber: `INV-${enrollment.bookingReference}`,
      issueDate: payment?.createdAt || enrollment.createdAt,
      bookingReference: enrollment.bookingReference,
      event: {
        id: enrollment.event.id,
        title: enrollment.event.title,
        eventDate: enrollment.event.eventDate,
        venueName: enrollment.event.venueName,
      },
      organizer: {
        companyName: enrollment.event.organizer?.companyName || 'Eventrix Host',
      },
      participant: {
        fullName: enrollment.user.fullName,
        email: enrollment.user.email,
      },
      ticketType: enrollment.ticketType?.name || 'Standard Entry',
      quantity: enrollment.quantity,
      currency: enrollment.event.currency || 'INR',
      breakdown,
    };
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Printable invoice lines for the emailed receipt. Mirrors the identical rule in
// Frontend's InvoiceDetailScreen: fee lines are shown ONLY when the participant actually
// paid them. Under feePayer=ORGANIZER the buyer was charged exactly the ticket price, and
// itemising platform/gateway/GST there would state charges they never incurred.
function buildInvoiceEmailLines(breakdown: FeeBreakdown): InvoiceEmailLine[] {
  const lines: InvoiceEmailLine[] = [{ label: 'Ticket price', amount: breakdown.ticketPrice }];
  if (breakdown.feePayer !== FeePayer.PARTICIPANT) return lines;

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

// How many leading hex characters of the enrollment uuid every PayU txnid carries, so a
// callback for any attempt — current or superseded — can be traced back to its booking.
// Read by both the minting side (resolvePendingPayUAttempt) and the decoding side
// (resolveEnrollmentForTxnid); they must agree.
const ENROLLMENT_ID_PREFIX_LENGTH = 20;

// PayU's hash format is pipe-delimited — see the comment at initiatePayUOrder's call site.
function sanitizePayUField(value: string): string {
  return value.replace(/\|/g, '-');
}
