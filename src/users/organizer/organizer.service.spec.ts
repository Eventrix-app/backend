import { OrganizerService } from './organizer.service';
import { Organizer, VerificationLevel } from '../../entities/organizer.entity';

describe('OrganizerService', () => {
  let service: OrganizerService;
  let mockUsersRepo: any;
  let mockOrganizersRepo: any;
  let mockEventsRepo: any;
  let mockFollowsRepo: any;
  let mockDataSource: any;
  let mockCacheService: any;
  let mockNotificationService: any;
  let mockUploadsService: any;

  beforeEach(() => {
    mockUsersRepo = { save: jest.fn((u) => Promise.resolve(u)), findOne: jest.fn().mockResolvedValue(null) };
    mockOrganizersRepo = { findOne: jest.fn(), save: jest.fn((o) => Promise.resolve(o)) };
    mockEventsRepo = { count: jest.fn() };
    mockFollowsRepo = { count: jest.fn(), exist: jest.fn(), find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(), delete: jest.fn() };
    // approveVerification/rejectVerification run inside a dataSource.transaction() now
    // (row-locked) — this mock manager just forwards findOne/save to the same
    // mockOrganizersRepo/mockUsersRepo the rest of the tests already configure, keyed off
    // which entity class the service asks for.
    mockDataSource = {
      transaction: jest.fn((cb: any) =>
        cb({
          findOne: jest.fn((entityClass: any, opts: any) =>
            entityClass === Organizer ? mockOrganizersRepo.findOne(opts) : mockUsersRepo.findOne(opts),
          ),
          save: jest.fn((entity: any) => (entity instanceof Object && 'roles' in entity ? mockUsersRepo.save(entity) : mockOrganizersRepo.save(entity))),
        }),
      ),
    };
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
      mockDataSource,
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

  // Regression tests (#3/#5): approve/reject previously acted on any organizer
  // regardless of whether a submission was actually pending review — an admin (or a
  // stray direct call) could approve one that never submitted documents, or act twice
  // on the same submission, re-firing a duplicate approval/rejection notification.
  describe('approveVerification / rejectVerification — require a pending submission', () => {
    function makeOrganizer(overrides: Record<string, unknown> = {}) {
      return {
        id: 'org-1',
        userId: 'user-1',
        companyName: 'Acme Events',
        commissionRate: 0,
        commissionFlatFee: 0,
        verificationLevel: VerificationLevel.UNVERIFIED,
        verified: false,
        rejectionReason: null,
        submittedForReviewAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: { id: 'user-1', fullName: 'Org Owner', roles: ['user'], deletedAt: null },
        ...overrides,
      };
    }

    it('approves a pending submission and grants the organizer role', async () => {
      const organizer = makeOrganizer({ submittedForReviewAt: new Date() });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      const result = await service.approveVerification('org-1');

      expect(result.verificationLevel).toBe(VerificationLevel.DOCUMENT_VERIFIED);
      expect(organizer.user.roles).toContain('organizer');
      expect(mockNotificationService.notifyOrganizerVerificationApproved).toHaveBeenCalledWith('user-1');
    });

    it('rejects approve when nothing has ever been submitted', async () => {
      const organizer = makeOrganizer({ submittedForReviewAt: null });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      await expect(service.approveVerification('org-1')).rejects.toThrow(
        /no submission is currently pending review/,
      );
      expect(mockNotificationService.notifyOrganizerVerificationApproved).not.toHaveBeenCalled();
    });

    it('rejects a second approve call on an already-approved organizer', async () => {
      const organizer = makeOrganizer({
        submittedForReviewAt: new Date(),
        verificationLevel: VerificationLevel.DOCUMENT_VERIFIED,
      });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      await expect(service.approveVerification('org-1')).rejects.toThrow(
        /no submission is currently pending review/,
      );
    });

    it('rejects approve on a submission that was already rejected (must resubmit first)', async () => {
      const organizer = makeOrganizer({
        submittedForReviewAt: null,
        rejectionReason: 'Blurry ID photo',
      });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      await expect(service.approveVerification('org-1')).rejects.toThrow(
        /no submission is currently pending review/,
      );
    });

    it('rejects a pending submission with a reason', async () => {
      const organizer = makeOrganizer({ submittedForReviewAt: new Date() });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      const result = await service.rejectVerification('org-1', 'Blurry ID photo');

      expect(result.verificationLevel).not.toBe(VerificationLevel.DOCUMENT_VERIFIED);
      expect(mockNotificationService.notifyOrganizerVerificationRejected).toHaveBeenCalledWith('user-1', 'Blurry ID photo');
    });

    it('rejects a second reject call on an already-rejected organizer (no duplicate notification)', async () => {
      const organizer = makeOrganizer({ submittedForReviewAt: null, rejectionReason: 'Already rejected once' });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      await expect(service.rejectVerification('org-1', 'Second reason')).rejects.toThrow(
        /no submission is currently pending review/,
      );
      expect(mockNotificationService.notifyOrganizerVerificationRejected).not.toHaveBeenCalled();
    });

    it('rejects reject-without-submission the same way approve does', async () => {
      const organizer = makeOrganizer({ submittedForReviewAt: null });
      mockOrganizersRepo.findOne.mockResolvedValue(organizer);

      await expect(service.rejectVerification('org-1', 'No submission')).rejects.toThrow(
        /no submission is currently pending review/,
      );
    });
  });
});
