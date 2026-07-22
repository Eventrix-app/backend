import { BadRequestException } from '@nestjs/common';
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
    );
  });

  describe('requestRefund', () => {
    it('rejects a refund request when the enrollment was never actually paid for', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        status: 'confirmed',
        paymentStatus: 'pending',
        totalAmount: '99.99',
        event: futureEvent,
      });

      await expect(
        service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockRefundsRepo.save).not.toHaveBeenCalled();
    });

    it('allows a refund request once the enrollment is actually paid, and emails a "request received" notice', async () => {
      mockEnrollmentsRepo.findOne.mockResolvedValue({
        id: 'enr-1',
        userId: 'user-1',
        status: 'confirmed',
        paymentStatus: 'paid',
        totalAmount: '99.99',
        event: futureEvent,
      });
      mockRefundsRepo.findOne.mockResolvedValue(null);

      const result = await service.requestRefund('user-1', { enrollmentId: 'enr-1', reason: 'test' } as any);

      expect(result.status).toBe(RefundStatus.REQUESTED);
      expect(mockRefundsRepo.save).toHaveBeenCalled();
      expect(mockNotificationService.notifyRefundStatus).toHaveBeenCalledWith(
        'user-1',
        'refund-1',
        RefundStatus.REQUESTED,
        'enr-1',
      );
    });
  });

  describe('handleWebhook', () => {
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
});
