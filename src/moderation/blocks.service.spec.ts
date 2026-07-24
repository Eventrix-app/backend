import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BlocksService } from './blocks.service';

describe('BlocksService', () => {
  let service: BlocksService;
  let mockBlocksRepo: jest.Mocked<any>;
  let mockUsersRepo: jest.Mocked<any>;

  beforeEach(() => {
    mockBlocksRepo = {
      create: jest.fn((data: any) => data),
      save: jest.fn((b: any) => Promise.resolve({ id: 'block-1', createdAt: new Date(), ...b })),
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
    };
    mockUsersRepo = { exists: jest.fn() };

    service = new BlocksService(mockBlocksRepo, mockUsersRepo);
  });

  describe('block', () => {
    it('rejects blocking yourself', async () => {
      await expect(service.block('user-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      mockUsersRepo.exists.mockResolvedValue(false);
      await expect(service.block('user-1', 'user-2')).rejects.toThrow(NotFoundException);
    });

    it('creates a block row when none exists yet', async () => {
      mockUsersRepo.exists.mockResolvedValue(true);
      mockBlocksRepo.findOne.mockResolvedValue(null);
      await service.block('user-1', 'user-2');
      expect(mockBlocksRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ blockerId: 'user-1', blockedId: 'user-2' }),
      );
    });

    it('is idempotent — does not create a duplicate row if already blocked', async () => {
      mockUsersRepo.exists.mockResolvedValue(true);
      mockBlocksRepo.findOne.mockResolvedValue({ id: 'existing-block' });
      await service.block('user-1', 'user-2');
      expect(mockBlocksRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('unblock', () => {
    it('deletes the row scoped to blocker and blocked', async () => {
      await service.unblock('user-1', 'user-2');
      expect(mockBlocksRepo.delete).toHaveBeenCalledWith({ blockerId: 'user-1', blockedId: 'user-2' });
    });
  });

  describe('listBlocked', () => {
    it('maps blocked-user rows to a flat record shape', async () => {
      mockBlocksRepo.find.mockResolvedValue([
        {
          createdAt: new Date('2026-01-01'),
          blocked: { id: 'user-2', fullName: 'Blocked Person', profilePictureUrl: null },
        },
      ]);
      const result = await service.listBlocked('user-1');
      expect(result).toEqual([
        { id: 'user-2', fullName: 'Blocked Person', profilePictureUrl: null, blockedAt: new Date('2026-01-01') },
      ]);
    });
  });

  describe('getBlockedUserIds', () => {
    it('returns just the blocked ids, for filtering', async () => {
      mockBlocksRepo.find.mockResolvedValue([{ blockedId: 'user-2' }, { blockedId: 'user-3' }]);
      const result = await service.getBlockedUserIds('user-1');
      expect(result).toEqual(['user-2', 'user-3']);
    });

    it('returns an empty array when nothing is blocked', async () => {
      mockBlocksRepo.find.mockResolvedValue([]);
      const result = await service.getBlockedUserIds('user-1');
      expect(result).toEqual([]);
    });
  });
});
