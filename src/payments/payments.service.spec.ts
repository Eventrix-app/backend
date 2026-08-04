import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
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

      expect(manager.qb.setLock).toHaveBeenCalledWith('pessimistic_write');
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
      // <20 hex chars of the enrollment uuid><base36 timestamp>, per resolvePendingPayUAttempt.
      const supersededDto = { ...dto, txnid: 'a1b2c3d4e5f60718293a' + 'k9xz12' };
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
          { id: enrollmentId, payuTxnId: 'a1b2c3d4e5f60718293a' + 'zz9999', totalAmount: '199.50', event: futureEvent },
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
        findOne: jest.fn().mockResolvedValue({ commissionRate: 0, commissionFlatFee: 0 }),
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
});
