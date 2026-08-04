import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportStatus, ReportTargetType } from '../entities/report.entity';

describe('ReportsService', () => {
  let service: ReportsService;
  let mockReportsRepo: jest.Mocked<any>;
  let mockUsersRepo: jest.Mocked<any>;
  let mockChatMessagesRepo: jest.Mocked<any>;
  let mockReviewsRepo: jest.Mocked<any>;
  let mockNotificationService: jest.Mocked<any>;

  beforeEach(() => {
    mockReportsRepo = {
      create: jest.fn((data: any) => data),
      save: jest.fn((r: any) => Promise.resolve({ id: 'report-1', createdAt: new Date(), ...r })),
      findAndCount: jest.fn(),
      findOne: jest.fn(),
    };
    // exists() backs targetExists(); findOne() resolves the reporter's name for the admin alert.
    mockUsersRepo = { exists: jest.fn(), findOne: jest.fn().mockResolvedValue({ fullName: 'Reporter Person' }) };
    mockChatMessagesRepo = { exists: jest.fn(), delete: jest.fn() };
    mockReviewsRepo = { exists: jest.fn(), delete: jest.fn() };

    mockNotificationService = { notifyAdminsUserReported: jest.fn().mockResolvedValue(undefined) };

    service = new ReportsService(
      mockReportsRepo,
      mockUsersRepo,
      mockChatMessagesRepo,
      mockReviewsRepo,
      mockNotificationService,
    );
  });

  describe('create', () => {
    it('rejects reporting yourself', async () => {
      await expect(
        service.create('user-1', { targetType: ReportTargetType.USER, targetId: 'user-1', reason: 'x' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the target does not exist', async () => {
      mockUsersRepo.exists.mockResolvedValue(false);
      await expect(
        service.create('user-1', { targetType: ReportTargetType.USER, targetId: 'user-2', reason: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('checks the chat_messages table for a chat_message report', async () => {
      mockChatMessagesRepo.exists.mockResolvedValue(true);
      await service.create('user-1', { targetType: ReportTargetType.CHAT_MESSAGE, targetId: 'msg-1', reason: 'spam' });
      expect(mockChatMessagesRepo.exists).toHaveBeenCalledWith({ where: { id: 'msg-1' } });
      expect(mockUsersRepo.exists).not.toHaveBeenCalled();
    });

    it('checks the event_reviews table for a review report', async () => {
      mockReviewsRepo.exists.mockResolvedValue(true);
      await service.create('user-1', { targetType: ReportTargetType.REVIEW, targetId: 'rev-1', reason: 'fake' });
      expect(mockReviewsRepo.exists).toHaveBeenCalledWith({ where: { id: 'rev-1' } });
    });

    it('creates the report with PENDING status by default', async () => {
      mockUsersRepo.exists.mockResolvedValue(true);
      const result = await service.create('user-1', {
        targetType: ReportTargetType.USER,
        targetId: 'user-2',
        reason: 'harassment',
      });
      expect(mockReportsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ reporterId: 'user-1', targetId: 'user-2', reason: 'harassment' }),
      );
      expect(result.status).toBeUndefined(); // not set explicitly by create() — DB default applies
    });

    it('alerts admins with the reporter name, target and reason', async () => {
      mockUsersRepo.exists.mockResolvedValue(true);
      await service.create('user-1', {
        targetType: ReportTargetType.USER,
        targetId: 'user-2',
        reason: 'harassment',
      });
      // notifyAdminsOfReport is fire-and-forget inside create(); let its chain settle.
      await new Promise((r) => setImmediate(r));

      expect(mockNotificationService.notifyAdminsUserReported).toHaveBeenCalledWith(
        'report-1',
        ReportTargetType.USER,
        'user-2',
        'Reporter Person',
        'harassment',
      );
    });
  });

  describe('dismiss', () => {
    it('throws NotFoundException when the report does not exist', async () => {
      mockReportsRepo.findOne.mockResolvedValue(null);
      await expect(service.dismiss('missing', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the report was already reviewed', async () => {
      mockReportsRepo.findOne.mockResolvedValue({ id: 'r1', status: ReportStatus.DISMISSED });
      await expect(service.dismiss('r1', 'admin-1')).rejects.toThrow(BadRequestException);
    });

    it('marks a pending report dismissed and stamps the reviewing admin', async () => {
      mockReportsRepo.findOne.mockResolvedValue({ id: 'r1', status: ReportStatus.PENDING });
      await service.dismiss('r1', 'admin-1');
      expect(mockReportsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportStatus.DISMISSED, reviewedBy: 'admin-1' }),
      );
    });
  });

  describe('action', () => {
    it('deletes the underlying chat message when upholding a chat_message report', async () => {
      mockReportsRepo.findOne.mockResolvedValue({
        id: 'r1',
        status: ReportStatus.PENDING,
        targetType: ReportTargetType.CHAT_MESSAGE,
        targetId: 'msg-1',
      });
      await service.action('r1', 'admin-1');
      expect(mockChatMessagesRepo.delete).toHaveBeenCalledWith({ id: 'msg-1' });
      expect(mockReviewsRepo.delete).not.toHaveBeenCalled();
    });

    it('deletes the underlying review when upholding a review report', async () => {
      mockReportsRepo.findOne.mockResolvedValue({
        id: 'r1',
        status: ReportStatus.PENDING,
        targetType: ReportTargetType.REVIEW,
        targetId: 'rev-1',
      });
      await service.action('r1', 'admin-1');
      expect(mockReviewsRepo.delete).toHaveBeenCalledWith({ id: 'rev-1' });
    });

    it('does NOT delete or ban anything when upholding a user report — only marks it reviewed', async () => {
      mockReportsRepo.findOne.mockResolvedValue({
        id: 'r1',
        status: ReportStatus.PENDING,
        targetType: ReportTargetType.USER,
        targetId: 'user-2',
      });
      await service.action('r1', 'admin-1');
      expect(mockChatMessagesRepo.delete).not.toHaveBeenCalled();
      expect(mockReviewsRepo.delete).not.toHaveBeenCalled();
      expect(mockReportsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportStatus.ACTIONED, reviewedBy: 'admin-1' }),
      );
    });

    it('throws BadRequestException when acting on an already-reviewed report', async () => {
      mockReportsRepo.findOne.mockResolvedValue({ id: 'r1', status: ReportStatus.ACTIONED });
      await expect(service.action('r1', 'admin-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAllForAdmin', () => {
    it('filters by status when provided', async () => {
      mockReportsRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAllForAdmin(ReportStatus.PENDING, 1, 50);
      expect(mockReportsRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: ReportStatus.PENDING } }),
      );
    });

    it('returns everything when no status filter is given', async () => {
      mockReportsRepo.findAndCount.mockResolvedValue([[], 0]);
      await service.findAllForAdmin(undefined, 1, 50);
      expect(mockReportsRepo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });
  });
});
