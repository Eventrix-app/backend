import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentsService, toPayuPhone, assertValidPayUTxnId } from './payments.service';
import { RefundStatus } from '../entities/refund.entity';

// Regression tests for the logs.md finding: a refund was requested, approved, and
// "processed via gateway" for an enrollment whose paymentStatus was still "pending"
// (the payment webhook hadn't fired yet). A later-arriving webhook then silently
// resurrected the refunded enrollment back to status:"confirmed", paymentStatus:"paid".
describe('PaymentsService — paymentStatus enforcement', () => {
  let service: PaymentsService;
  let mockPaymentsRepo: any;
  let mockCommissionsRepo: any;
  let mockRefundsRepo: any;
  let mockEnrollmentsRepo: any;
  let mockEventsRepo: any;
  let mockOrganizersRepo: any;
  let mockUsersRepo: any;
  let mockPayoutsRepo: any;
  let mockTicketTypesRepo: any;
  let mockDataSource: any;
  let mockConfigService: any;
  let mockFeeCalculationService: any;
  let mockWaitlistService: any;
  let mockNotificationService: any;
  let mockCacheService: any;
  let mockRazorpayService: any;
  let mockPayUService: any;
  let mockLedgerService: any;

  const futureEvent = {
    id: 'event-1',
    title: 'Future Concert',
    organizerId: 'org-1',
    eventDate: '2099-01-01',
    startTime: '10:00:00',
    currency: 'INR',
    feePayer: 'organizer',
  };

  beforeEach(() => {
    mockPaymentsRepo = { query: jest.fn(), findOne: jest.fn() };
    mockCommissionsRepo = {};
    mockRefundsRepo = { findOne: jest.fn(), create: jest.fn((d: any) => d), save: jest.fn((d: any) => Promise.resolve({ id: 'refund-1', ...d })) };
    mockEnrollmentsRepo = { findOne: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn() };
    mockEventsRepo = { findOne: jest.fn() };
    mockOrganizersRepo = { findOne: jest.fn() };
    mockUsersRepo = { findOne: jest.fn() };
    mockPayoutsRepo = {};
    mockTicketTypesRepo = { findOne: jest.fn() };
    mockDataSource = { transaction: jest.fn() };
    mockConfigService = { get: jest.fn((key: string, def: any) => def) };
    // Settlement, payout and invoicing all split an ALREADY-CHARGED amount, so they go
    // through calculateFromChargedAmount; calculate() is only for the pre-booking paths.
    mockFeeCalculationService = { calculate: jest.fn(), calculateFromChargedAmount: jest.fn() };
    mockWaitlistService = { promoteNext: jest.fn() };
    mockNotificationService = {
      notifyRefundStatus: jest.fn(),
      notifyBookingConfirmed: jest.fn(),
      // Receipt to the buyer on settlement, settlement summary to the organizer on payout —
      // both fired after their transaction commits, so both must exist on the mock.
      notifyInvoiceIssued: jest.fn(),
      notifyPayoutProcessed: jest.fn(),
      // Fired by markPayoutPaid() once a transfer confirms — distinct from the settlement
      // summary above, which only says what is owed.
      notifyPayoutPaid: jest.fn(),
    };
    mockCacheService = { del: jest.fn(), bumpVersion: jest.fn() };
    mockRazorpayService = {
      createOrder: jest.fn(),
      verifyCheckoutSignature: jest.fn(),
      fetchOrder: jest.fn(),
      keyId: 'rzp_test_key',
    };
    mockPayUService = {
      generateRequestHash: jest.fn(),
      verifyReverseHash: jest.fn(),
      refundTransaction: jest.fn(),
      signHash: jest.fn(),
      merchantKey: 'payu_test_key',
      actionUrl: 'https://test.payu.in/_payment',
      isTestMode: true,
    };
    mockLedgerService = {
      recordPaymentLedger: jest.fn(),
      recordPayoutLedger: jest.fn(),
      recordRefundLedger: jest.fn(),
      // Empty map = "these bookings have no ledger entries", which settleEventPayout treats
      // as unreconcilable-but-payable (pre-ledger rows) rather than as a mismatch. That keeps
      // every pre-existing payout test exercising what it was written to exercise; the
      // reconciliation behaviour itself has its own describe block below.
      getOrganizerPayableByEnrollment: jest.fn().mockResolvedValue(new Map()),
    };

    service = new PaymentsService(
      mockPaymentsRepo,
      mockCommissionsRepo,
      mockRefundsRepo,
      mockEnrollmentsRepo,
      mockEventsRepo,
      mockOrganizersRepo,
      mockUsersRepo,
      mockPayoutsRepo,
      mockTicketTypesRepo,
      mockDataSource,
      mockConfigService,
      mockFeeCalculationService,
      mockWaitlistService,
      mockNotificationService,
      mockCacheService,
      mockRazorpayService,
      mockPayUService,
      mockLedgerService,
    );
  });

  describe('requestRefund', () => {
    // requestRefund now runs inside dataSource.transaction() with a pessimistic_write lock
    // on the enrollment row (see the fix comment in payments.service.ts) — the existing
    // "is this enrollment eligible" checks and the "any open refund already?" check both
    // happen against a transactional `manager`, not the plain repositories directly.
    function mockManagerFor(enrollment: any, existingOpenRefund: any = null) {
      const qb: any = {};
      qb.setLock = jest.fn().mockReturnValue(qb);
      qb.leftJoinAndSelect = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.getOne = jest.fn().mockResolvedValue(enrollment);
      return {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        findOne: jest.fn().mockResolvedValue(existingOpenRefund),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'refund-1', ...data })),
        qb,
      };
    }

    it('rejects a refund request when the enrollment was never actually paid for', async () => {
      const manager = mockManagerFor({
        id: 'enr-1',
        userId: 'user-1',
        status: 'confirmed',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      await expect(
        service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('rejects a refund request when one is already open for the same booking', async () => {
      const manager = mockManagerFor(
        {
          id: 'enr-1',
          userId: 'user-1',
          status: 'confirmed',
          paymentStatus: 'paid',
          totalAmount: '99.99',
          event: futureEvent,
        },
        { id: 'refund-existing', status: RefundStatus.REQUESTED },
      );
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      await expect(
        service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('locks the enrollment row before checking for an existing open refund, closing the double-request race', async () => {
      const manager = mockManagerFor({
        id: 'enr-1',
        userId: 'user-1',
        status: 'confirmed',
        paymentStatus: 'paid',
        totalAmount: '99.99',
        event: futureEvent,
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      await service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any);

      // The table list is not optional here: the query left-joins event, and a bare
      // FOR UPDATE spans every table in the FROM, which Postgres refuses on an outer
      // join's nullable side. Asserting only the mode let that 500 ship once already.
      expect(manager.qb.setLock).toHaveBeenCalledWith('pessimistic_write', undefined, ['enrollment']);
    });

    it('allows a refund request once the enrollment is actually paid, and emails a "request received" notice', async () => {
      const manager = mockManagerFor({
        id: 'enr-1',
        userId: 'user-1',
        status: 'confirmed',
        paymentStatus: 'paid',
        totalAmount: '99.99',
        event: futureEvent,
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      const result = await service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any);

      expect(result.status).toBe(RefundStatus.REQUESTED);
      expect(manager.save).toHaveBeenCalled();
      expect(mockNotificationService.notifyRefundStatus).toHaveBeenCalledWith(
        'user-1',
        'refund-1',
        RefundStatus.REQUESTED,
        'enr-1',
      );
    });
  });

  // The reason an organizer types when refusing a refund used to exist only as a log line:
  // the participant was told their request was declined and nothing else. It is now written
  // to the refund row and carried into the notification, which is what lets the app show it
  // on the booking and the email repeat it.
  describe('rejectRefund', () => {
    const rejectionReason = 'Ticket was already used at the gate';

    beforeEach(() => {
      mockRefundsRepo.findOne.mockResolvedValue({
        id: 'refund-1',
        enrollmentId: 'enr-1',
        requestedBy: 'user-1',
        status: RefundStatus.REQUESTED,
      });
    });

    // Mirrors lockAndTransitionRefund's manager: a locked read followed by a save of the
    // mutated row.
    function mockRejectionTransaction() {
      const locked = {
        id: 'refund-1',
        enrollmentId: 'enr-1',
        requestedBy: 'user-1',
        status: RefundStatus.REQUESTED,
      };
      const manager = {
        createQueryBuilder: jest.fn(() => ({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(locked),
        })),
        save: jest.fn((_entity: any, row: any) => Promise.resolve(row)),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      return manager;
    }

    it('persists the rejection reason on the refund rather than only logging it', async () => {
      const manager = mockRejectionTransaction();

      const rejected = await service.rejectRefund('refund-1', rejectionReason, 'admin-1', ['admin']);

      expect(rejected.status).toBe(RefundStatus.REJECTED);
      expect(rejected.rejectionReason).toBe(rejectionReason);
      expect(manager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rejectionReason, status: RefundStatus.REJECTED }),
      );
    });

    it('leaves the requester\'s own reason intact — the request and the decision are separate facts', async () => {
      mockRefundsRepo.findOne.mockResolvedValue({
        id: 'refund-1',
        enrollmentId: 'enr-1',
        requestedBy: 'user-1',
        reason: 'I can no longer attend',
        status: RefundStatus.REQUESTED,
      });
      mockDataSource.transaction.mockImplementation((cb: any) =>
        cb({
          createQueryBuilder: jest.fn(() => ({
            setLock: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue({
              id: 'refund-1',
              enrollmentId: 'enr-1',
              requestedBy: 'user-1',
              reason: 'I can no longer attend',
              status: RefundStatus.REQUESTED,
            }),
          })),
          save: jest.fn((_entity: any, row: any) => Promise.resolve(row)),
        }),
      );

      const rejected = await service.rejectRefund('refund-1', rejectionReason, 'admin-1', ['admin']);

      expect(rejected.reason).toBe('I can no longer attend');
      expect(rejected.rejectionReason).toBe(rejectionReason);
    });

    it('passes the reason to the notification so the push and the email can repeat it', async () => {
      mockRejectionTransaction();

      await service.rejectRefund('refund-1', rejectionReason, 'admin-1', ['admin']);

      expect(mockNotificationService.notifyRefundStatus).toHaveBeenCalledWith(
        'user-1',
        'refund-1',
        RefundStatus.REJECTED,
        'enr-1',
        rejectionReason,
      );
    });
  });

  describe('createOrder', () => {
    it('rejects creating an order for another user\'s enrollment', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'someone-else',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      });

      await expect(service.createOrder('user-1', { enrollmentId: 'enr-1' } as any)).rejects.toThrow();
      expect(mockRazorpayService.createOrder).not.toHaveBeenCalled();
    });

    it('rejects creating an order for a free (zero-amount) booking', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'paid',
        totalAmount: '0',
        event: futureEvent,
      });

      await expect(service.createOrder('user-1', { enrollmentId: 'enr-1' } as any)).rejects.toThrow(BadRequestException);
      expect(mockRazorpayService.createOrder).not.toHaveBeenCalled();
    });

    it('creates a Razorpay order for the enrollment\'s own totalAmount', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'pending',
        totalAmount: '199.50',
        event: futureEvent,
      });
      mockRazorpayService.createOrder.mockResolvedValue({ id: 'order_abc', amount: 19950, currency: 'INR' });

      const result = await service.createOrder('user-1', { enrollmentId: 'enr-1' } as any);

      expect(mockRazorpayService.createOrder).toHaveBeenCalledWith(199.5, 'INR', 'enrollment_enr-1', {
        enrollmentId: 'enr-1',
        userId: 'user-1',
      });
      expect(result).toEqual({ orderId: 'order_abc', amount: 19950, currency: 'INR', keyId: 'rzp_test_key' });
    });
  });

  describe('initiatePayUOrder', () => {
    it('rejects initiating an order for another user\'s enrollment', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'someone-else',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      });

      await expect(service.initiatePayUOrder('user-1', { enrollmentId: 'enr-1' } as any)).rejects.toThrow();
      expect(mockPayUService.generateRequestHash).not.toHaveBeenCalled();
    });

    it('rejects initiating an order for a free (zero-amount) booking', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'paid',
        totalAmount: '0',
        event: futureEvent,
      });

      await expect(service.initiatePayUOrder('user-1', { enrollmentId: 'enr-1' } as any)).rejects.toThrow(BadRequestException);
      expect(mockPayUService.generateRequestHash).not.toHaveBeenCalled();
    });

    it('mints a fresh txnid, persists it on the enrollment, and returns the fields PayUCheckoutModal needs', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'pending',
        totalAmount: '199.50',
        event: futureEvent,
      });
      mockUsersRepo.findOne.mockResolvedValue({ id: 'user-1', fullName: 'Aarish Sheikh', email: 'a@example.com', phoneNumber: '9999999999' });
      mockPayUService.generateRequestHash.mockReturnValue('computed-hash');

      const result = await service.initiatePayUOrder('user-1', { enrollmentId: 'enr-1' } as any);

      expect(mockEnrollmentsRepo.update).toHaveBeenCalledWith('enr-1', { payuTxnId: expect.any(String) });
      expect(mockPayUService.generateRequestHash).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 199.5, firstname: 'Aarish', email: 'a@example.com' }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          amount: 199.5,
          firstname: 'Aarish',
          email: 'a@example.com',
          phone: '9999999999',
          key: 'payu_test_key',
          hash: 'computed-hash',
          actionUrl: 'https://test.payu.in/_payment',
        }),
      );
    });

    it('strips pipe characters from productinfo/firstname before hashing — PayU\'s hash is pipe-delimited, so a literal "|" in an event title or name would shift every field after it', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'pending',
        totalAmount: '199.50',
        event: { ...futureEvent, title: 'VIP | Backstage Pass' },
      });
      mockUsersRepo.findOne.mockResolvedValue({ id: 'user-1', fullName: 'A|arish', email: 'a@example.com', phoneNumber: '9999999999' });

      const result = await service.initiatePayUOrder('user-1', { enrollmentId: 'enr-1' } as any);

      expect(mockPayUService.generateRequestHash).toHaveBeenCalledWith(
        expect.objectContaining({ productinfo: 'VIP - Backstage Pass', firstname: 'A-arish' }),
      );
      expect(result.productinfo).toBe('VIP - Backstage Pass');
      expect(result.firstname).toBe('A-arish');
    });
  });

  describe('initiatePayUNativeOrder', () => {
    it('returns the native SDK\'s camelCase field shape with no pre-computed hash', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        paymentStatus: 'pending',
        totalAmount: '199.50',
        event: futureEvent,
      });
      mockUsersRepo.findOne.mockResolvedValue({ id: 'user-1', fullName: 'Aarish Sheikh', email: 'a@example.com', phoneNumber: '9999999999' });

      const result = await service.initiatePayUNativeOrder('user-1', { enrollmentId: 'enr-1' } as any);

      expect(mockPayUService.generateRequestHash).not.toHaveBeenCalled();
      expect(result).toEqual({
        key: 'payu_test_key',
        transactionId: expect.any(String),
        amount: 199.5,
        productInfo: 'Future Concert',
        firstName: 'Aarish',
        email: 'a@example.com',
        phone: '9999999999',
        environment: '1',
      });
    });

    it('rejects initiating a native order for another user\'s enrollment (same guard as the WebView path)', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'someone-else',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      });

      await expect(service.initiatePayUNativeOrder('user-1', { enrollmentId: 'enr-1' } as any)).rejects.toThrow();
    });
  });

  describe('signPayUHash', () => {
    it('delegates directly to PayUService.signHash', () => {
      mockPayUService.signHash.mockReturnValue('signed-hash');
      expect(service.signPayUHash('raw-string')).toBe('signed-hash');
      expect(mockPayUService.signHash).toHaveBeenCalledWith('raw-string');
    });
  });

  // The whole point of this endpoint: the number on the "Pay ₹X" button must be the number
  // the gateway is actually asked for. CheckoutScreen previously computed it client-side from
  // hardcoded constants (flat ₹9 + 18% of the ticket), which matched nothing the backend does.
  describe('getCheckoutEstimate', () => {
    const tier = (price: number, feePayer: string, organizer: unknown) => ({
      id: 'tt-1',
      price: String(price),
      currency: 'INR',
      event: { feePayer, currency: 'INR', organizer },
    });

    it('adds no fees on top under the default organizer-pays configuration', async () => {
      mockTicketTypesRepo.findOne.mockResolvedValue(tier(1000, 'organizer', { commissionRate: 10, commissionFlatFee: 0 }));
      mockFeeCalculationService.calculate.mockReturnValue({
        platformCommissionAmount: 100,
        gatewayFeeAmount: 23,
        gstAmount: 18,
        buyerPrice: 1000,
      });

      const result = await service.getCheckoutEstimate({ ticketTypeId: 'tt-1', quantity: 1 });

      expect(result.total).toBe(1000);
      // The organizer's commission is their own business — never itemised to the buyer, who
      // was not charged it.
      expect(result.lines).toEqual([]);
    });

    it('itemises every fee the buyer actually pays under participant-pays', async () => {
      mockTicketTypesRepo.findOne.mockResolvedValue(tier(1000, 'participant', { commissionRate: 10, commissionFlatFee: 0 }));
      mockFeeCalculationService.calculate.mockReturnValue({
        platformCommissionAmount: 100,
        gatewayFeeAmount: 23,
        gstAmount: 18,
        buyerPrice: 1141,
      });

      const result = await service.getCheckoutEstimate({ ticketTypeId: 'tt-1', quantity: 1 });

      expect(result.total).toBe(1141);
      expect(result.lines).toEqual([
        { label: 'Platform fee', amount: 100 },
        { label: 'Payment gateway fee', amount: 23 },
        { label: 'GST (18% on platform fee)', amount: 18 },
      ]);
      // Subtotal + itemised lines must reconcile to the total, or the summary visibly fails
      // to add up on screen.
      expect(result.subtotal + result.lines.reduce((s, l) => s + l.amount, 0)).toBe(result.total);
    });

    it('computes fees on price x quantity, the same base enroll() uses', async () => {
      mockTicketTypesRepo.findOne.mockResolvedValue(tier(250, 'participant', { commissionRate: 0, commissionFlatFee: 0 }));
      mockFeeCalculationService.calculate.mockReturnValue({
        platformCommissionAmount: 0,
        gatewayFeeAmount: 23,
        gstAmount: 0,
        buyerPrice: 1023,
      });

      const result = await service.getCheckoutEstimate({ ticketTypeId: 'tt-1', quantity: 4 });

      expect(mockFeeCalculationService.calculate).toHaveBeenCalledWith(1000, expect.anything(), 'participant');
      expect(result.subtotal).toBe(1000);
    });

    it('404s for a ticket type that does not exist', async () => {
      mockTicketTypesRepo.findOne.mockResolvedValue(null);
      await expect(service.getCheckoutEstimate({ ticketTypeId: 'tt-x', quantity: 1 })).rejects.toThrow(NotFoundException);
    });

    it('falls through to the platform default when the organizer has no negotiated rate', async () => {
      mockTicketTypesRepo.findOne.mockResolvedValue(tier(500, 'participant', null));
      mockFeeCalculationService.calculate.mockReturnValue({
        platformCommissionAmount: 0,
        gatewayFeeAmount: 13,
        gstAmount: 0,
        buyerPrice: 513,
      });

      const result = await service.getCheckoutEstimate({ ticketTypeId: 'tt-1', quantity: 1 });

      // null, NOT 0 — the fee service resolves null to the platform default (5%). Passing 0
      // here would read as a negotiated commission-free deal and suppress the default.
      expect(mockFeeCalculationService.calculate).toHaveBeenCalledWith(
        500,
        { commissionRate: null, commissionFlatFee: null },
        'participant',
      );
      expect(result.total).toBe(513);
    });
  });

  // A payout row is an OBLIGATION, not evidence money moved — nothing in this codebase
  // transfers funds. Defaulting to PAID overstated settlement on every single payout.
  describe('payout settlement honesty', () => {
    it('creates payouts as PENDING with processedAt, never PAID', async () => {
      const qb: any = {};
      qb.setLock = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getMany = jest.fn().mockResolvedValue([{ id: 'enr-1', totalAmount: '100', payoutId: null }]);
      let savedPayout: any;
      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        find: jest.fn().mockResolvedValue([]),
        // settleEventPayout re-reads the event's status inside the transaction before doing
        // anything else (a cancelled event must never be swept), so the mock has to answer
        // per-entity rather than returning the organizer for every lookup.
        findOne: jest.fn((entity: any) =>
          Promise.resolve(
            entity?.name === 'Event'
              ? { id: 'event-1', status: 'completed' }
              : { id: 'org-1', userId: 'u-1', commissionRate: null, commissionFlatFee: null },
          ),
        ),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => {
          if (data && data.ticketCount !== undefined) savedPayout = data;
          return Promise.resolve({ id: 'payout-1', ...data });
        }),
        update: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        organizerPayout: 100, buyerPrice: 100, platformCommissionAmount: 5, gatewayFeeAmount: 5,
      });

      await (service as any).settleEventPayout({
        id: 'event-1', organizerId: 'org-1', currency: 'INR', feePayer: 'organizer', title: 'E',
      });

      expect(savedPayout.status).toBe('pending');
      expect(savedPayout.processedAt).toBeInstanceOf(Date);
      // paidAt must stay unset — no transfer has happened.
      expect(savedPayout.paidAt).toBeUndefined();
    });

    it('markPayoutPaid is the only path to PAID, and stamps paidAt', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({ id: 'p-1', status: 'pending' });
      mockPayoutsRepo.save = jest.fn((d: any) => Promise.resolve(d));

      const result = await service.markPayoutPaid('p-1', 'utr-123');

      expect(result.status).toBe('paid');
      expect(result.paidAt).toBeInstanceOf(Date);
    });

    it('markPayoutPaid is idempotent — a duplicate confirmation cannot rewrite paidAt', async () => {
      const already = { id: 'p-1', status: 'paid', paidAt: new Date('2020-01-01') };
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue(already);
      mockPayoutsRepo.save = jest.fn();

      const result = await service.markPayoutPaid('p-1');

      expect(result.paidAt).toEqual(new Date('2020-01-01'));
      expect(mockPayoutsRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to mark a failed payout as paid', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({ id: 'p-1', status: 'failed' });
      await expect(service.markPayoutPaid('p-1')).rejects.toThrow(BadRequestException);
    });

    // The reference is the organizer's only proof the transfer happened — it used to be
    // logged and discarded, which left a PAID row with nothing to reconcile against.
    it('persists the transfer reference and notes onto the payout row', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({
        id: 'p-1', status: 'pending', amount: 900, eventId: 'event-1',
        organizer: { userId: 'user-1' }, event: { title: 'Launch Night' },
      });
      mockPayoutsRepo.save = jest.fn((d: any) => Promise.resolve(d));

      const result = await service.markPayoutPaid('p-1', 'UTR-99887766', 'paid manually via NEFT');

      expect(result.transferReference).toBe('UTR-99887766');
      expect(result.notes).toBe('paid manually via NEFT');
    });

    it('notifies the organizer that money was actually sent, with the reference', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({
        id: 'p-1', status: 'pending', amount: 900, eventId: 'event-1',
        organizer: { userId: 'user-1' }, event: { title: 'Launch Night' },
      });
      mockPayoutsRepo.save = jest.fn((d: any) => Promise.resolve(d));
      mockNotificationService.notifyPayoutPaid = jest.fn().mockResolvedValue(undefined);

      await service.markPayoutPaid('p-1', 'UTR-99887766');

      expect(mockNotificationService.notifyPayoutPaid).toHaveBeenCalledWith('user-1', {
        payoutId: 'p-1',
        eventId: 'event-1',
        eventTitle: 'Launch Night',
        payoutAmount: 900,
        transferReference: 'UTR-99887766',
      });
    });

    // A duplicate provider webhook must not tell the organizer twice that they were paid.
    it('does not re-notify when confirming an already-paid payout', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({
        id: 'p-1', status: 'paid', paidAt: new Date('2020-01-01'), organizer: { userId: 'user-1' },
      });
      mockPayoutsRepo.save = jest.fn();
      mockNotificationService.notifyPayoutPaid = jest.fn();

      await service.markPayoutPaid('p-1', 'UTR-99887766');

      expect(mockNotificationService.notifyPayoutPaid).not.toHaveBeenCalled();
    });

    // The transfer has already happened at the bank by this point; a notification failure
    // must not turn it back into an unpaid payout.
    it('still marks the payout paid when the notification fails', async () => {
      mockPayoutsRepo.findOne = jest.fn().mockResolvedValue({
        id: 'p-1', status: 'pending', amount: 900, eventId: 'event-1',
        organizer: { userId: 'user-1' }, event: { title: 'Launch Night' },
      });
      mockPayoutsRepo.save = jest.fn((d: any) => Promise.resolve(d));
      mockNotificationService.notifyPayoutPaid = jest.fn().mockRejectedValue(new Error('smtp down'));

      const result = await service.markPayoutPaid('p-1', 'UTR-99887766');

      expect(result.status).toBe('paid');
    });
  });

  // PayU's SDK rejects anything that is not exactly 10 digits, from inside native code, so a
  // bad value here surfaces as an unexplained popup on the checkout screen rather than
  // anything traceable. These are the shapes Edit Profile actually accepts today — it
  // applies no format validation at all.
  // Mirrors PayuUtils.isValidTxnId, decompiled from in.payu:paymentparamhelper. The real
  // check runs in native code on the device, so nothing here can catch a violation at
  // runtime — these assertions are the only place the format is verified before a user hits
  // "InValid transactionId" with no server-side trace of why.
  describe('assertValidPayUTxnId', () => {
    const mint = (enrollmentId: string) =>
      `${enrollmentId.replace(/-/g, '').slice(0, 17)}${Date.now().toString(36)}`;

    it('accepts the txnid format resolvePendingPayUAttempt actually mints', () => {
      const txnid = mint('a1b2c3d4-e5f6-0718-293a-bbbbbbbbbbbb');
      expect(() => assertValidPayUTxnId(txnid)).not.toThrow();
      expect(txnid.length).toBeLessThanOrEqual(25);
    });

    // The regression that broke every native checkout: a 20-char prefix plus an 8-char
    // base36 timestamp is 28 characters, three over PayU's cap.
    it('rejects the 28-character form that PayU refused', () => {
      const tooLong = `${'a1b2c3d4e5f60718293a'}${Date.now().toString(36)}`;
      expect(tooLong.length).toBeGreaterThan(25);
      expect(() => assertValidPayUTxnId(tooLong)).toThrow(/violates PayU's rule/);
    });

    it('rejects non-alphanumeric characters', () => {
      expect(() => assertValidPayUTxnId('abc-123')).toThrow(/violates PayU's rule/);
      expect(() => assertValidPayUTxnId('abc_123')).toThrow(/violates PayU's rule/);
      expect(() => assertValidPayUTxnId('')).toThrow(/violates PayU's rule/);
    });

    it('accepts exactly 25 characters, the documented boundary', () => {
      expect(() => assertValidPayUTxnId('a'.repeat(25))).not.toThrow();
      expect(() => assertValidPayUTxnId('a'.repeat(26))).toThrow(/violates PayU's rule/);
    });
  });

  describe('toPayuPhone', () => {
    it.each([
      ['a plain 10-digit number', '9876543210'],
      ['a +91 country code with spaces', '+91 98765 43210'],
      ['a 0091 international prefix', '00919876543210'],
      ['a leading trunk zero', '09876543210'],
      ['hyphenated input', '98765-43210'],
      ['bracketed country code', '(+91) 9876543210'],
    ])('accepts %s', (_label, input) => {
      expect(toPayuPhone(input)).toBe('9876543210');
    });

    // The original bug: phoneNumber is nullable and never collected at signup, so every
    // account that had not visited Edit Profile sent '' straight to PayU.
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['too few digits', '98765'],
      ['letters only', 'not a phone'],
    ])('rejects %s with an actionable message', (_label, input) => {
      expect(() => toPayuPhone(input)).toThrow(BadRequestException);
      expect(() => toPayuPhone(input)).toThrow(/10-digit mobile number/);
    });
  });

  describe('findMyPayouts', () => {
    // The whole point of this route: it takes no organizerId, so there is no parameter to
    // tamper with. Scoping is derived from the session's user id.
    it('scopes the query to the caller\'s own organizer row', async () => {
      mockOrganizersRepo.findOne = jest.fn().mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockPayoutsRepo.findAndCount = jest.fn().mockResolvedValue([[], 0]);

      await service.findMyPayouts('user-1');

      expect(mockOrganizersRepo.findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(mockPayoutsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizerId: 'org-1' } }),
      );
    });

    // A user who has never hosted anything has no organizer row. That is a normal state for
    // a participant, not an error, and must render the empty screen rather than a failure.
    it('returns an empty page for a user with no organizer profile', async () => {
      mockOrganizersRepo.findOne = jest.fn().mockResolvedValue(null);
      mockPayoutsRepo.findAndCount = jest.fn();

      const result = await service.findMyPayouts('user-nobody');

      expect(result).toEqual({ payouts: [], total: 0, page: 1, totalPages: 0 });
      expect(mockPayoutsRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('projects the fields an organizer needs and drops the admin-only notes', async () => {
      mockOrganizersRepo.findOne = jest.fn().mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockPayoutsRepo.findAndCount = jest.fn().mockResolvedValue([
        [
          {
            id: 'p-1', eventId: 'event-1', ticketCount: 10, amount: '4750.00', currency: 'INR',
            status: 'paid', paidAt: new Date('2026-08-10T00:00:00Z'), processedAt: new Date('2026-08-09T00:00:00Z'),
            transferReference: 'UTR-1', notes: 'internal only — never leaves the admin console',
            event: { id: 'event-1', title: 'Tech Meetup', eventDate: '2026-08-05' },
          },
        ],
        1,
      ]);

      const { payouts } = await service.findMyPayouts('user-1');

      expect(payouts[0].transferReference).toBe('UTR-1');
      expect(payouts[0].eventTitle).toBe('Tech Meetup');
      // pg returns decimals as strings; the app must not hand a string to a currency format.
      expect(payouts[0].amount).toBe(4750);
      expect(payouts[0]).not.toHaveProperty('notes');
    });

    // An estimated arrival date on a payout nobody has sent yet would read as a promise.
    it('offers an arrival estimate only once a transfer has actually been sent', async () => {
      mockOrganizersRepo.findOne = jest.fn().mockResolvedValue({ id: 'org-1', userId: 'user-1' });
      mockPayoutsRepo.findAndCount = jest.fn().mockResolvedValue([
        [
          { id: 'p-1', eventId: 'e1', ticketCount: 1, amount: 100, currency: 'INR', status: 'pending', event: { title: 'A' } },
          // Friday → skips the weekend, lands Tuesday.
          { id: 'p-2', eventId: 'e2', ticketCount: 1, amount: 100, currency: 'INR', status: 'paid', paidAt: new Date('2026-08-07T00:00:00Z'), event: { title: 'B' } },
        ],
        2,
      ]);

      const { payouts } = await service.findMyPayouts('user-1');

      expect(payouts[0].estimatedArrivalDate).toBeUndefined();
      expect(payouts[1].estimatedArrivalDate?.getDay()).toBe(2);
    });
  });

  describe('handlePayUReturn', () => {
    const dto = {
      txnid: 'txn-1',
      mihpayid: 'mihpay_1',
      status: 'success' as const,
      amount: '199.50',
      productinfo: 'Future Concert',
      firstname: 'Aarish',
      email: 'a@example.com',
      hash: 'valid-hash',
    };

    it('returns null for a return callback whose txnid does not match any enrollment', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue(null);

      const result = await service.handlePayUReturn(dto);

      expect(result).toBeNull();
      expect(mockPayUService.verifyReverseHash).not.toHaveBeenCalled();
    });

    // A retry mints a fresh txnid and overwrites enrollment.payuTxnId (PayU rejects a reused
    // one), so a late callback for the SUPERSEDED attempt used to match nothing — buyer
    // charged, booking never confirmed. The txnid embeds the enrollment id, so it is still
    // recoverable without any extra column.
    describe('superseded txnid recovery', () => {
      // <17 hex chars of the enrollment uuid><base36 timestamp>, per resolvePendingPayUAttempt.
      // 17, not 20: PayU caps txnid at 25 characters (see assertValidPayUTxnId).
      const supersededDto = { ...dto, txnid: 'a1b2c3d4e5f607182' + 'k9xz12' };
      const enrollmentId = 'a1b2c3d4-e5f6-0718-293a-bbbbbbbbbbbb';

      const mockPrefixLookup = (matches: unknown[]) => {
        const qb = {
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(matches),
        };
        mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);
        return qb;
      };

      it('resolves the enrollment from the id embedded in a superseded txnid', async () => {
        mockEnrollmentsRepo.findOne.mockResolvedValue(null); // current payuTxnId is the newer attempt
        mockPrefixLookup([
          { id: enrollmentId, payuTxnId: 'a1b2c3d4e5f607182' + 'zz9999', totalAmount: '199.50', event: futureEvent },
        ]);
        mockPayUService.verifyReverseHash.mockReturnValue(true);
        const handleWebhookSpy = jest.spyOn(service, 'handleWebhook').mockResolvedValue({ id: 'payment-1' } as any);

        await service.handlePayUReturn(supersededDto);

        expect(handleWebhookSpy).toHaveBeenCalledWith(expect.objectContaining({ enrollmentId }));
      });

      it('still enforces the reverse hash on the recovered enrollment', async () => {
        mockEnrollmentsRepo.findOne.mockResolvedValue(null);
        mockPrefixLookup([{ id: enrollmentId, totalAmount: '199.50', event: futureEvent }]);
        mockPayUService.verifyReverseHash.mockReturnValue(false);

        expect(await service.handlePayUReturn(supersededDto)).toBeNull();
      });

      it('refuses to guess when the prefix matches more than one enrollment', async () => {
        mockEnrollmentsRepo.findOne.mockResolvedValue(null);
        mockPrefixLookup([
          { id: enrollmentId, totalAmount: '199.50', event: futureEvent },
          { id: 'a1b2c3d4-e5f6-0718-293a-cccccccccccc', totalAmount: '199.50', event: futureEvent },
        ]);

        expect(await service.handlePayUReturn(supersededDto)).toBeNull();
        expect(mockPayUService.verifyReverseHash).not.toHaveBeenCalled();
      });

      it('never runs the prefix query for a txnid that is not ours', async () => {
        mockEnrollmentsRepo.findOne.mockResolvedValue(null);

        expect(await service.handlePayUReturn({ ...dto, txnid: "'; DROP TABLE enrollments;--" })).toBeNull();
        expect(mockEnrollmentsRepo.createQueryBuilder).not.toHaveBeenCalled();
      });
    });

    it('returns null when the reverse hash fails verification (forged callback)', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-1', totalAmount: '199.50', event: futureEvent });
      mockPayUService.verifyReverseHash.mockReturnValue(false);

      const result = await service.handlePayUReturn(dto);

      expect(result).toBeNull();
    });

    it('returns null when the callback amount does not match the enrollment (tampering)', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-1', totalAmount: '999.00', event: futureEvent });
      mockPayUService.verifyReverseHash.mockReturnValue(true);

      const result = await service.handlePayUReturn(dto);

      expect(result).toBeNull();
    });

    it('delegates to handleWebhook with gateway PAYU once the hash and amount both check out', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-1', totalAmount: '199.50', event: futureEvent });
      mockPayUService.verifyReverseHash.mockReturnValue(true);
      const handleWebhookSpy = jest.spyOn(service, 'handleWebhook').mockResolvedValue({ id: 'payment-1' } as any);

      await service.handlePayUReturn(dto);

      expect(handleWebhookSpy).toHaveBeenCalledWith({
        gateway: 'payu',
        gatewayEventId: 'mihpay_1',
        gatewayPaymentId: 'mihpay_1',
        enrollmentId: 'enr-1',
        amount: 199.5,
        status: 'success',
      });
    });

    it('maps a "failure" callback status to a failed webhook status', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-1', totalAmount: '199.50', event: futureEvent });
      mockPayUService.verifyReverseHash.mockReturnValue(true);
      const handleWebhookSpy = jest.spyOn(service, 'handleWebhook').mockResolvedValue({ id: 'payment-1' } as any);

      await service.handlePayUReturn({ ...dto, status: 'failure' });

      expect(handleWebhookSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('verifyPayment', () => {
    it('rejects a signature that fails verification', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-1', userId: 'user-1', totalAmount: '99.99' });
      mockRazorpayService.verifyCheckoutSignature.mockReturnValue(false);

      await expect(
        service.verifyPayment('user-1', {
          enrollmentId: 'enr-1',
          razorpayOrderId: 'order_1',
          razorpayPaymentId: 'pay_1',
          razorpaySignature: 'bad-signature',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an order that was created for a different enrollment (replay across bookings)', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-2', userId: 'user-1', totalAmount: '50000' });
      mockRazorpayService.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpayService.fetchOrder.mockResolvedValue({ notes: { enrollmentId: 'enr-1' }, amount: 100 });

      await expect(
        service.verifyPayment('user-1', {
          enrollmentId: 'enr-2',
          razorpayOrderId: 'order_for_enr-1',
          razorpayPaymentId: 'pay_1',
          razorpaySignature: 'good-signature',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an order whose amount does not match the enrollment being confirmed', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({ id: 'enr-2', userId: 'user-1', totalAmount: '99.99' });
      mockRazorpayService.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpayService.fetchOrder.mockResolvedValue({ notes: { enrollmentId: 'enr-2' }, amount: 100 });

      await expect(
        service.verifyPayment('user-1', {
          enrollmentId: 'enr-2',
          razorpayOrderId: 'order_1',
          razorpayPaymentId: 'pay_1',
          razorpaySignature: 'good-signature',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('confirms the booking via handleWebhook once the signature and order both check out', async () => {
      const enrollment = {
        id: 'enr-2',
        userId: 'user-1',
        eventId: 'event-1',
        bookingReference: 'BK-2',
        quantity: 1,
        status: 'confirmed',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      };
      mockEnrollmentsRepo.findOne.mockResolvedValue(enrollment);
      mockRazorpayService.verifyCheckoutSignature.mockReturnValue(true);
      mockRazorpayService.fetchOrder.mockResolvedValue({ notes: { enrollmentId: 'enr-2' }, amount: 9999 });
      const manager = {
        findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment).mockResolvedValueOnce(null),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-1', ...data })),
        transaction: jest.fn((cb: any) => cb(manager)),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({ platformCommissionAmount: 0, gatewayFeeAmount: 5 });

      await service.verifyPayment('user-1', {
        enrollmentId: 'enr-2',
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'good-signature',
      });

      expect(enrollment.status).toBe('confirmed');
      expect(enrollment.paymentStatus).toBe('paid');
    });
  });

  describe('handleWebhook', () => {
    it('recovers from a concurrent unique-constraint race without erroring on an aborted transaction', async () => {
      const enrollment = { id: 'enr-9', status: 'confirmed', paymentStatus: 'pending', event: futureEvent };
      const racedPayment = { id: 'payment-winner', gatewayEventId: 'evt-race' };
      const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
      const manager = {
        findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment),
        create: jest.fn((entity: any, data: any) => data),
        // The nested manager.transaction() call (the savepoint) is what actually throws.
        transaction: jest.fn(() => Promise.reject(uniqueViolation)),
        findOneOrFail: jest.fn().mockResolvedValue(racedPayment),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      const result = await service.handleWebhook({
        gateway: 'razorpay',
        gatewayEventId: 'evt-race',
        gatewayPaymentId: 'pay-race',
        enrollmentId: 'enr-9',
        amount: 50,
        status: 'success',
      } as any);

      expect(result).toEqual(racedPayment);
      expect(manager.findOneOrFail).toHaveBeenCalledWith(expect.anything(), { where: { gatewayEventId: 'evt-race' } });
    });

    it('does not resurrect an already-refunded enrollment when a late success webhook arrives', async () => {
      const enrollment = {
        id: 'enr-1',
        status: 'refunded',
        paymentStatus: 'refunded',
        event: futureEvent,
      };
      const manager = {
        // First findOne call = Payment idempotency check (null = no duplicate), second = Enrollment lookup.
        findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-1', ...data })),
        transaction: jest.fn((cb: any) => cb(manager)),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      await service.handleWebhook({
        gateway: 'razorpay',
        gatewayEventId: 'evt-late',
        gatewayPaymentId: 'pay-late',
        enrollmentId: 'enr-1',
        amount: 99.99,
        status: 'success',
      } as any);

      // Enrollment must never be touched — only the Payment row is saved.
      const enrollmentSaveCalls = manager.save.mock.calls.filter((c: any[]) => c[1] === enrollment);
      expect(enrollmentSaveCalls).toHaveLength(0);
      expect(enrollment.status).toBe('refunded');
      expect(enrollment.paymentStatus).toBe('refunded');
    });

    // The receipt the buyer gets. Separate from the booking confirmation above, which
    // carries the ticket + QR — a receipt forwarded to an accountant shouldn't include it.
    describe('invoice receipt', () => {
      const runSuccessfulWebhook = async (feePayer: string, breakdown: Record<string, number>) => {
        const enrollment = {
          id: 'enr-inv',
          userId: 'user-inv',
          eventId: 'event-1',
          bookingReference: 'BK-INV',
          quantity: 1,
          status: 'confirmed',
          paymentStatus: 'pending',
          event: { ...futureEvent, feePayer, currency: 'INR', title: 'Future Concert' },
        };
        const manager = {
          findOne: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(enrollment)
            .mockResolvedValueOnce({ commissionRate: 10, commissionFlatFee: 0 }),
          create: jest.fn((entity: any, data: any) => data),
          save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-1', ...data })),
          transaction: jest.fn((cb: any) => cb(manager)),
        };
        mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
        mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({ feePayer, ...breakdown });

        await service.handleWebhook({
          gateway: 'payu',
          gatewayEventId: 'evt-inv',
          gatewayPaymentId: 'mihpay-inv',
          enrollmentId: 'enr-inv',
          amount: breakdown.buyerPrice,
          status: 'success',
        } as any);
      };

      it('itemises every fee the participant actually paid', async () => {
        await runSuccessfulWebhook('participant', {
          ticketPrice: 1000,
          platformCommissionAmount: 100,
          gatewayFeeAmount: 23,
          gstAmount: 18,
          buyerPrice: 1141,
        });

        expect(mockNotificationService.notifyInvoiceIssued).toHaveBeenCalledWith(
          'user-inv',
          expect.objectContaining({
            invoiceNumber: 'INV-BK-INV',
            total: 1141,
            transactionId: 'mihpay-inv',
            lines: [
              { label: 'Ticket price', amount: 1000 },
              { label: 'Platform fee', amount: 100 },
              { label: 'Payment gateway fee', amount: 23 },
              // Rate derived from the amounts, never hardcoded.
              { label: 'GST (18% on platform fee)', amount: 18 },
            ],
          }),
        );
      });

      it('shows only the ticket price when the organizer absorbed the fees', async () => {
        await runSuccessfulWebhook('organizer', {
          ticketPrice: 1000,
          platformCommissionAmount: 100,
          gatewayFeeAmount: 23,
          gstAmount: 18,
          buyerPrice: 1000,
        });

        // Listing platform/gateway/GST here would claim charges the buyer never incurred.
        expect(mockNotificationService.notifyInvoiceIssued).toHaveBeenCalledWith(
          'user-inv',
          expect.objectContaining({ total: 1000, lines: [{ label: 'Ticket price', amount: 1000 }] }),
        );
      });

      it('is not sent when the payment failed', async () => {
        const enrollment = {
          id: 'enr-fail',
          userId: 'user-fail',
          status: 'confirmed',
          paymentStatus: 'pending',
          event: futureEvent,
        };
        const manager = {
          findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment),
          create: jest.fn((entity: any, data: any) => data),
          save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'p', ...data })),
          transaction: jest.fn((cb: any) => cb(manager)),
        };
        mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

        await service.handleWebhook({
          gateway: 'payu',
          gatewayEventId: 'evt-fail',
          gatewayPaymentId: 'mihpay-fail',
          enrollmentId: 'enr-fail',
          amount: 100,
          status: 'failed',
        } as any);

        expect(mockNotificationService.notifyInvoiceIssued).not.toHaveBeenCalled();
      });
    });

    it('still confirms a normal (non-terminal) enrollment on a success webhook and emails a booking confirmation', async () => {
      const enrollment = {
        id: 'enr-2',
        userId: 'user-2',
        eventId: 'event-1',
        bookingReference: 'BK-2',
        quantity: 2,
        status: 'confirmed',
        paymentStatus: 'pending',
        event: futureEvent,
      };
      const manager = {
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null) // idempotency check
          .mockResolvedValueOnce(enrollment) // enrollment lookup
          .mockResolvedValueOnce(null), // organizer lookup
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-1', ...data })),
        transaction: jest.fn((cb: any) => cb(manager)),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        platformCommissionAmount: 0,
        gatewayFeeAmount: 5,
      });

      await service.handleWebhook({
        gateway: 'razorpay',
        gatewayEventId: 'evt-1',
        gatewayPaymentId: 'pay-1',
        enrollmentId: 'enr-2',
        amount: 99.99,
        status: 'success',
      } as any);

      expect(enrollment.status).toBe('confirmed');
      expect(enrollment.paymentStatus).toBe('paid');
      expect(mockNotificationService.notifyBookingConfirmed).toHaveBeenCalledWith(
        'user-2',
        'event-1',
        'enr-2',
        'Future Concert',
        'BK-2',
        2,
        undefined,
        '2099-01-01',
        '10:00:00',
        undefined,
      );
    });

    it('does not email a booking confirmation on a failed payment webhook', async () => {
      const enrollment = {
        id: 'enr-3',
        userId: 'user-3',
        eventId: 'event-1',
        bookingReference: 'BK-3',
        quantity: 1,
        status: 'confirmed',
        paymentStatus: 'pending',
        event: futureEvent,
      };
      const manager = {
        findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-2', ...data })),
        transaction: jest.fn((cb: any) => cb(manager)),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      await service.handleWebhook({
        gateway: 'razorpay',
        gatewayEventId: 'evt-2',
        gatewayPaymentId: 'pay-2',
        enrollmentId: 'enr-3',
        amount: 99.99,
        status: 'failed',
      } as any);

      expect(enrollment.paymentStatus).toBe('failed');
      expect(mockNotificationService.notifyBookingConfirmed).not.toHaveBeenCalled();
    });
  });

  // Two checkout sheets opened before either resolves are both minted while the enrollment
  // is still 'pending', so both can succeed at PayU with distinct mihpayids. The
  // gatewayEventId idempotency check does not catch that — they are genuinely different
  // payments — so without an explicit guard the settlement branch ran twice and booked two
  // Commission rows plus two full sets of ledger entries against one ticket.
  it('records a second successful payment but does not re-book commission or ledger', async () => {
    const enrollment = {
      id: 'enr-dup',
      userId: 'user-1',
      eventId: 'event-1',
      bookingReference: 'BK-DUP',
      quantity: 1,
      status: 'confirmed',
      paymentStatus: 'paid', // already settled by the first payment
      totalAmount: '199.50',
      event: futureEvent,
    };
    const manager = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(enrollment),
      create: jest.fn((entity: any, data: any) => data),
      save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payment-dup', ...data })),
      transaction: jest.fn((cb: any) => cb(manager)),
    };
    mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

    const payment = await service.handleWebhook({
      gateway: 'payu',
      gatewayEventId: 'mihpay-second',
      gatewayPaymentId: 'mihpay-second',
      enrollmentId: 'enr-dup',
      amount: 199.5,
      status: 'success',
    } as any);

    // The money is real, so the Payment row is still written for the audit trail.
    expect(payment).toBeDefined();
    // But nothing downstream is double-counted.
    expect(mockLedgerService.recordPaymentLedger).not.toHaveBeenCalled();
    expect(mockFeeCalculationService.calculateFromChargedAmount).not.toHaveBeenCalled();
    // And the buyer is not told they are confirmed a second time.
    expect(mockNotificationService.notifyBookingConfirmed).not.toHaveBeenCalled();
  });

  describe('runPayoutSweep candidate query', () => {
    it('filters payout candidates to paid enrollments only', async () => {
      const qb: any = {};
      qb.select = jest.fn().mockReturnValue(qb);
      qb.distinct = jest.fn().mockReturnValue(qb);
      // Joined to events so the T+3 eligibility predicate can be applied in SQL rather than
      // by loading every candidate event and discarding the ones not yet due.
      qb.innerJoin = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.runPayoutSweep();

      expect(qb.andWhere).toHaveBeenCalledWith('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' });
    });

    // This predicate is raw SQL that no test executes against a real database, and it has to
    // agree with getEventEndDateTime(). Two ways it silently went wrong before: using
    // event_date instead of event_end_date (wrong end for a multi-day event), and comparing
    // IST wall-clock values as if they were UTC, which made the filter 5.5h STRICTER than
    // the authoritative JS check and delayed every single-day payout by that much.
    it('filters on the multi-day end date, interpreted as IST', async () => {
      const qb: any = {};
      qb.select = jest.fn().mockReturnValue(qb);
      qb.distinct = jest.fn().mockReturnValue(qb);
      qb.innerJoin = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.runPayoutSweep();

      const predicate = qb.andWhere.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(predicate).toContain('COALESCE(event.event_end_date, event.event_date)');
      expect(predicate).toContain("AT TIME ZONE 'Asia/Kolkata'");
      // timestamptz, not timestamp — an absolute instant compared against the converted
      // event end, rather than two naive values living in different frames.
      expect(predicate).toContain(':now::timestamptz');
    });

    // A cancelled event's enrollments can legitimately still read confirmed/paid — refunds
    // may have been issued out of band, or not yet processed. Filtering on the enrollment
    // alone therefore paid the organizer the full gross for an event whose attendees had
    // already been given their money back, and the platform ate both sides.
    it('excludes cancelled events from the candidate query', async () => {
      const qb: any = {};
      qb.select = jest.fn().mockReturnValue(qb);
      qb.distinct = jest.fn().mockReturnValue(qb);
      qb.innerJoin = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.runPayoutSweep();

      expect(qb.andWhere).toHaveBeenCalledWith('event.status != :cancelledEvent', {
        cancelledEvent: 'cancelled',
      });
    });

    it('filters to events already past their payout delay in SQL, not in JS', async () => {
      const qb: any = {};
      qb.select = jest.fn().mockReturnValue(qb);
      qb.distinct = jest.fn().mockReturnValue(qb);
      qb.innerJoin = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.runPayoutSweep();

      expect(qb.innerJoin).toHaveBeenCalled();
      const dueFilter = qb.andWhere.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('make_interval'),
      );
      expect(dueFilter).toBeDefined();
      expect(dueFilter[1]).toEqual(expect.objectContaining({ delayDays: expect.any(Number) }));
      // No event should be loaded individually when nothing is due.
      expect(mockEventsRepo.findOne).not.toHaveBeenCalled();
    });

    it('emails the organizer a settlement summary once a payout is created', async () => {
      const qb: any = {};
      qb.select = jest.fn().mockReturnValue(qb);
      qb.distinct = jest.fn().mockReturnValue(qb);
      qb.innerJoin = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([{ eventId: 'event-1' }]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);
      // Ended yesterday, so the JS re-check agrees with the SQL pre-filter.
      const ended = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      mockEventsRepo.findOne.mockResolvedValue({
        id: 'event-1',
        organizerId: 'org-1',
        currency: 'INR',
        feePayer: 'organizer',
        title: 'Past Concert',
        eventDate: ended,
        startTime: '10:00',
        endTime: '12:00',
      });
      mockConfigService.get.mockImplementation((key: string, def: any) => (key === 'payout.delayDaysAfterEventEnd' ? 0 : def));

      const settleSpy = jest.spyOn(service as any, 'settleEventPayout').mockResolvedValue({
        organizerUserId: 'organizer-user-1',
        payoutId: 'payout-9',
        eventId: 'event-1',
        eventTitle: 'Past Concert',
        ticketCount: 3,
        grossRevenue: 3000,
        platformFee: 300,
        gatewayFee: 69,
        payoutAmount: 2631,
      });

      const result = await service.runPayoutSweep();

      expect(settleSpy).toHaveBeenCalled();
      expect(result.payoutsCreated).toBe(1);
      expect(mockNotificationService.notifyPayoutProcessed).toHaveBeenCalledWith(
        'organizer-user-1',
        expect.objectContaining({ payoutId: 'payout-9', ticketCount: 3, payoutAmount: 2631 }),
      );
    });
  });

  describe('settleEventPayout — refund re-check after locking', () => {
    it('excludes an enrollment that picked up an open refund in the window before the lock was granted', async () => {
      const payableEnrollment = { id: 'enr-payable', totalAmount: '100', payoutId: null };
      const disputedEnrollment = { id: 'enr-disputed', totalAmount: '100', payoutId: null };
      const qb: any = {};
      qb.setLock = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getMany = jest.fn().mockResolvedValue([payableEnrollment, disputedEnrollment]);

      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        find: jest.fn().mockResolvedValue([{ enrollmentId: 'enr-disputed' }]),
        findOne: jest.fn((entity: any) =>
          Promise.resolve(
            entity?.name === 'Event'
              ? { id: 'event-1', status: 'completed' }
              : { commissionRate: 0, commissionFlatFee: 0 },
          ),
        ),
        create: jest.fn((entity: any, data: any) => data),
        save: jest.fn((entity: any, data: any) => Promise.resolve({ id: 'payout-1', ...data })),
        update: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        organizerPayout: 100,
        buyerPrice: 100,
        platformCommissionAmount: 0,
        gatewayFeeAmount: 0,
      });

      const event = { id: 'event-1', organizerId: 'org-1', currency: 'INR', feePayer: 'organizer' };
      // Returns the settlement summary (not a boolean) so runPayoutSweep can email the
      // organizer only after this transaction has committed.
      const created = await (service as any).settleEventPayout(event);

      expect(created).toEqual(expect.objectContaining({ payoutId: 'payout-1', ticketCount: 1 }));
      expect(manager.update).toHaveBeenCalledWith(expect.anything(), ['enr-payable'], { payoutId: 'payout-1' });
    });

    it('skips the payout entirely when every locked enrollment turns out to have an open refund', async () => {
      const disputedEnrollment = { id: 'enr-disputed', totalAmount: '100', payoutId: null };
      const qb: any = {};
      qb.setLock = jest.fn().mockReturnValue(qb);
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getMany = jest.fn().mockResolvedValue([disputedEnrollment]);

      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
        find: jest.fn().mockResolvedValue([{ enrollmentId: 'enr-disputed' }]),
        findOne: jest.fn().mockResolvedValue({ id: 'event-1', status: 'completed' }),
        save: jest.fn(),
        update: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      const event = { id: 'event-1', organizerId: 'org-1', currency: 'INR', feePayer: 'organizer' };
      const created = await (service as any).settleEventPayout(event);

      expect(created).toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  // Builds the manager mock every settleEventPayout test needs, so each test below can state
  // only the thing it is actually about.
  const settlementManager = (opts: {
    enrollments: any[];
    eventStatus?: string;
    openRefunds?: { enrollmentId: string }[];
  }) => {
    const qb: any = {};
    qb.setLock = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.getMany = jest.fn().mockResolvedValue(opts.enrollments);
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      find: jest.fn().mockResolvedValue(opts.openRefunds ?? []),
      findOne: jest.fn((entity: any) =>
        Promise.resolve(
          entity?.name === 'Event'
            ? { id: 'event-1', status: opts.eventStatus ?? 'completed' }
            : { id: 'org-1', userId: 'u-1', commissionRate: null, commissionFlatFee: null },
        ),
      ),
      create: jest.fn((_entity: any, data: any) => data),
      save: jest.fn((_entity: any, data: any) => Promise.resolve({ id: 'payout-1', ...data })),
      update: jest.fn(),
    };
  };

  const eventUnderSettlement = {
    id: 'event-1',
    organizerId: 'org-1',
    currency: 'INR',
    feePayer: 'organizer',
    title: 'E',
    isPaid: true,
  };

  describe('settleEventPayout — cancelled event guard', () => {
    // The SQL pre-filter excludes cancelled events, but it runs before the loop and before
    // this transaction opens. An organizer cancelling inside that window would still have
    // been paid, which is exactly the moment a payout must not happen.
    it('refuses to settle an event that was cancelled after the sweep selected it', async () => {
      const manager = settlementManager({
        enrollments: [{ id: 'enr-1', totalAmount: '1000', payoutId: null }],
        eventStatus: 'cancelled',
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created).toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
      // Bailed before even locking the enrollments.
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses to settle an event that has disappeared entirely', async () => {
      const manager = settlementManager({ enrollments: [{ id: 'enr-1', totalAmount: '1000' }] });
      manager.findOne = jest.fn((entity: any) =>
        Promise.resolve(entity?.name === 'Event' ? null : { id: 'org-1', userId: 'u-1' }),
      ) as any;
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));

      expect(await (service as any).settleEventPayout(eventUnderSettlement)).toBeNull();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  // The whole point of freezing: an admin editing an organizer's commission rate must not
  // change what is owed for tickets that were already sold and already invoiced.
  describe('settleEventPayout — frozen fee split', () => {
    const frozenEnrollment = {
      id: 'enr-frozen',
      totalAmount: '1000',
      payoutId: null,
      feesFrozenAt: new Date('2026-01-01'),
      feePayerApplied: 'organizer',
      commissionRateApplied: '0.00',
      commissionFlatFeeApplied: '0.00',
      ticketBaseAmount: '1000.00',
      platformFeeAmount: '0.00',
      gatewayFeeAmount: '0.00',
      gstAmount: '0.00',
      // Booked at a negotiated 0% — the organizer keeps the whole ticket price.
      organizerPayoutAmount: '1000.00',
    };

    it('pays the rate frozen at payment time, not the organizer’s current rate', async () => {
      const manager = settlementManager({ enrollments: [frozenEnrollment] });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      // The organizer has since been moved to a rate that would take ₹73 off this booking.
      // If it were consulted, the payout would come out at 927 instead of 1000.
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        organizerPayout: 927, buyerPrice: 1000, platformCommissionAmount: 50, gatewayFeeAmount: 23, gstAmount: 0,
      });

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created!.payoutAmount).toBe(1000);
      // Not consulted at all — the frozen columns answered the question outright.
      expect(mockFeeCalculationService.calculateFromChargedAmount).not.toHaveBeenCalled();
    });

    // feesFrozenAt is the presence flag precisely so that a frozen split whose amounts are
    // all zero is still recognised as frozen. Testing an amount column instead would treat a
    // commission-free partner as unfrozen and silently fall back to live rates.
    it('treats an all-zero frozen split as frozen, not as absent', async () => {
      const manager = settlementManager({
        enrollments: [
          { ...frozenEnrollment, id: 'enr-zero', totalAmount: '12.50', platformFeeAmount: '12.50', ticketBaseAmount: '0.00', organizerPayoutAmount: '0.00' },
        ],
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        organizerPayout: 999, buyerPrice: 999, platformCommissionAmount: 0, gatewayFeeAmount: 0, gstAmount: 0,
      });

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created!.payoutAmount).toBe(0);
      expect(mockFeeCalculationService.calculateFromChargedAmount).not.toHaveBeenCalled();
    });

    it('falls back to recomputation for a booking made before the freeze existed', async () => {
      const manager = settlementManager({
        enrollments: [{ id: 'enr-legacy', totalAmount: '1000', payoutId: null, feesFrozenAt: null }],
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockFeeCalculationService.calculateFromChargedAmount.mockReturnValue({
        organizerPayout: 927, buyerPrice: 1000, platformCommissionAmount: 50, gatewayFeeAmount: 23, gstAmount: 0,
      });

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created!.payoutAmount).toBe(927);
      expect(mockFeeCalculationService.calculateFromChargedAmount).toHaveBeenCalled();
    });
  });

  // Before this, the ledger was write-only: entries were recorded on every payment and never
  // read back, so the bookings and the ledger could disagree about what an organizer was owed
  // indefinitely, with nothing to notice and no way to reconstruct which was right.
  describe('settleEventPayout — ledger reconciliation', () => {
    const ledgeredEnrollment = (id: string, payout: number) => ({
      id,
      totalAmount: String(payout),
      payoutId: null,
      feesFrozenAt: new Date('2026-01-01'),
      feePayerApplied: 'organizer',
      ticketBaseAmount: String(payout),
      platformFeeAmount: '0.00',
      gatewayFeeAmount: '0.00',
      gstAmount: '0.00',
      organizerPayoutAmount: payout.toFixed(2),
    });

    it('creates the payout when the ledger agrees', async () => {
      const manager = settlementManager({ enrollments: [ledgeredEnrollment('enr-1', 1000)] });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockLedgerService.getOrganizerPayableByEnrollment.mockResolvedValue(new Map([['enr-1', 1000]]));

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created).toEqual(expect.objectContaining({ payoutId: 'payout-1', payoutAmount: 1000 }));
    });

    // Blocking is the only safe response to a disagreement: a transferred payout is
    // irreversible, an unmade one is not. The event stays eligible, so a corrected
    // divergence heals on the next sweep without intervention.
    it('blocks the payout when the ledger disagrees, leaving the event eligible for retry', async () => {
      const manager = settlementManager({ enrollments: [ledgeredEnrollment('enr-1', 1000)] });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockLedgerService.getOrganizerPayableByEnrollment.mockResolvedValue(new Map([['enr-1', 900]]));

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      expect(created).toBeNull();
      // Critically: no payout row, and no enrollment stamped with a payoutId — so nothing
      // marks these bookings as settled and the next sweep will pick them up again.
      expect(manager.update).not.toHaveBeenCalled();
      expect(mockLedgerService.recordPayoutLedger).not.toHaveBeenCalled();
    });

    // Reconciling only on the grand total would pass this: +100 and -100 sum to zero while
    // both bookings are individually wrong.
    it('catches two equal-and-opposite per-booking errors that cancel in the total', async () => {
      const manager = settlementManager({
        enrollments: [ledgeredEnrollment('enr-1', 1000), ledgeredEnrollment('enr-2', 1000)],
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockLedgerService.getOrganizerPayableByEnrollment.mockResolvedValue(
        new Map([['enr-1', 1100], ['enr-2', 900]]),
      );

      expect(await (service as any).settleEventPayout(eventUnderSettlement)).toBeNull();
      expect(manager.update).not.toHaveBeenCalled();
    });

    // Bookings that predate the ledger have nothing to reconcile against. Treating a missing
    // ledger as a balance of 0 would block them from ever being paid.
    it('pays out bookings with no ledger entries rather than blocking on them', async () => {
      const manager = settlementManager({
        enrollments: [ledgeredEnrollment('enr-ledgered', 1000), ledgeredEnrollment('enr-legacy', 500)],
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      // Only one of the two has ledger entries.
      mockLedgerService.getOrganizerPayableByEnrollment.mockResolvedValue(new Map([['enr-ledgered', 1000]]));

      const created = await (service as any).settleEventPayout(eventUnderSettlement);

      // Both are paid; the ledgered one still had to reconcile to get there.
      expect(created!.payoutAmount).toBe(1500);
    });

    it('still blocks when a ledgered booking diverges alongside an unledgered one', async () => {
      const manager = settlementManager({
        enrollments: [ledgeredEnrollment('enr-ledgered', 1000), ledgeredEnrollment('enr-legacy', 500)],
      });
      mockDataSource.transaction.mockImplementation((cb: any) => cb(manager));
      mockLedgerService.getOrganizerPayableByEnrollment.mockResolvedValue(new Map([['enr-ledgered', 950]]));

      expect(await (service as any).settleEventPayout(eventUnderSettlement)).toBeNull();
    });
  });
});
