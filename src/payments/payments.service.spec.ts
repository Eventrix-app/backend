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
  let mockPayoutsRepo: any;
  let mockDataSource: any;
  let mockConfigService: any;
  let mockFeeCalculationService: any;
  let mockWaitlistService: any;
  let mockNotificationService: any;
  let mockCacheService: any;
  let mockRazorpayService: any;

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
    mockPaymentsRepo = { query: jest.fn() };
    mockCommissionsRepo = {};
    mockRefundsRepo = { findOne: jest.fn(), create: jest.fn((d: any) => d), save: jest.fn((d: any) => Promise.resolve({ id: 'refund-1', ...d })) };
    mockEnrollmentsRepo = { findOne: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn() };
    mockEventsRepo = { findOne: jest.fn() };
    mockOrganizersRepo = { findOne: jest.fn() };
    mockPayoutsRepo = {};
    mockDataSource = { transaction: jest.fn() };
    mockConfigService = { get: jest.fn((key: string, def: any) => def) };
    mockFeeCalculationService = { calculate: jest.fn() };
    mockWaitlistService = { promoteNext: jest.fn() };
    mockNotificationService = { notifyRefundStatus: jest.fn(), notifyBookingConfirmed: jest.fn() };
    mockCacheService = { del: jest.fn(), bumpVersion: jest.fn() };
    mockRazorpayService = {
      createOrder: jest.fn(),
      verifyCheckoutSignature: jest.fn(),
      fetchOrder: jest.fn(),
      keyId: 'rzp_test_key',
    };

    service = new PaymentsService(
      mockPaymentsRepo,
      mockCommissionsRepo,
      mockRefundsRepo,
      mockEnrollmentsRepo,
      mockEventsRepo,
      mockOrganizersRepo,
      mockPayoutsRepo,
      mockDataSource,
      mockConfigService,
      mockFeeCalculationService,
      mockWaitlistService,
      mockNotificationService,
      mockCacheService,
      mockRazorpayService,
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
      mockFeeCalculationService.calculate.mockReturnValue({ platformCommissionAmount: 0, gatewayFeeAmount: 5 });

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
      mockFeeCalculationService.calculate.mockReturnValue({
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
      qb.where = jest.fn().mockReturnValue(qb);
      qb.andWhere = jest.fn().mockReturnValue(qb);
      qb.getRawMany = jest.fn().mockResolvedValue([]);
      mockEnrollmentsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.runPayoutSweep();

      expect(qb.andWhere).toHaveBeenCalledWith('enrollment.paymentStatus = :paymentStatus', { paymentStatus: 'paid' });
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
      mockFeeCalculationService.calculate.mockReturnValue({ organizerPayout: 100 });

      const event = { id: 'event-1', organizerId: 'org-1', currency: 'INR', feePayer: 'organizer' };
      const created = await (service as any).settleEventPayout(event);

      expect(created).toBe(true);
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

      expect(created).toBe(false);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
