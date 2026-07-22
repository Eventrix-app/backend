import { OrganizerService } from './organizer.service';
import { VerificationLevel } from '../../entities/organizer.entity';

describe('OrganizerService', () => {
  let service: OrganizerService;
  let mockUsersRepo: any;
  let mockOrganizersRepo: any;
  let mockEventsRepo: any;
  let mockFollowsRepo: any;
  let mockCacheService: any;
  let mockNotificationService: any;
  let mockUploadsService: any;

  beforeEach(() => {
    mockUsersRepo = { save: jest.fn((u) => Promise.resolve(u)), findOne: jest.fn().mockResolvedValue(null) };
    mockOrganizersRepo = { findOne: jest.fn(), save: jest.fn((o) => Promise.resolve(o)) };
    mockEventsRepo = { count: jest.fn() };
    mockFollowsRepo = { count: jest.fn(), exist: jest.fn(), find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(), delete: jest.fn() };
    mockCacheService = { del: jest.fn().mockResolvedValue(undefined) };
    mockNotificationService = {
      notifyOrganizerFollowed: jest.fn().mockResolvedValue(undefined),
      notifyOrganizerVerificationApproved: jest.fn().mockResolvedValue(undefined),
      notifyOrganizerVerificationRejected: jest.fn().mockResolvedValue(undefined),
    };
    mockUploadsService = { createSignedReadUrl: jest.fn().mockResolvedValue('https://signed.example.com') };
    service = new OrganizerService(
      mockUsersRepo,
      mockOrganizersRepo,
      mockEventsRepo,
      mockFollowsRepo,
      mockCacheService,
      mockNotificationService,
      mockUploadsService,
    );
  });

  // Regression test for multipart.md §3.4 / §4: companyLogoUrl previously existed on
  // the entity but no DTO/endpoint ever persisted it — this proves the field now
  // actually round-trips through update().
  it('persists companyLogoUrl obtained from the signed-upload flow', async () => {
    const organizer = {
      id: 'org-1',
      companyLogoUrl: undefined,
      commissionRate: 0,
      commissionFlatFee: 0,
      verificationLevel: VerificationLevel.UNVERIFIED,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'user-1', fullName: 'Org Owner', deletedAt: null },
    };
    mockOrganizersRepo.findOne.mockResolvedValue(organizer);

    const result = await service.update('org-1', {
      companyLogoUrl: 'https://x.supabase.co/public/organizer-logos/user-1/abc.png',
    });

    expect(mockOrganizersRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ companyLogoUrl: 'https://x.supabase.co/public/organizer-logos/user-1/abc.png' }),
    );
    expect(result.companyLogoUrl).toBe('https://x.supabase.co/public/organizer-logos/user-1/abc.png');
  });

  it('leaves companyLogoUrl untouched when not present in the update payload', async () => {
    const organizer = {
      id: 'org-1',
      companyLogoUrl: 'https://existing.example.com/logo.png',
      commissionRate: 0,
      commissionFlatFee: 0,
      verificationLevel: VerificationLevel.UNVERIFIED,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'user-1', fullName: 'Org Owner', deletedAt: null },
    };
    mockOrganizersRepo.findOne.mockResolvedValue(organizer);

    const result = await service.update('org-1', { firstName: 'New' });

    expect(result.companyLogoUrl).toBe('https://existing.example.com/logo.png');
  });
});
