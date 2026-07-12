import { ForbiddenException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { UploadPurpose } from './dto/create-signed-url.dto';

const mockCreateSignedUploadUrl = jest.fn();
const mockGetPublicUrl = jest.fn();
const mockFrom = jest.fn(() => ({
  createSignedUploadUrl: mockCreateSignedUploadUrl,
  getPublicUrl: mockGetPublicUrl,
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ storage: { from: mockFrom } })),
}));

describe('UploadsService', () => {
  let service: UploadsService;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigService = { get: jest.fn((key: string) => (key === 'SUPABASE_URL' ? 'https://x.supabase.co' : 'service-role-key')) };
    service = new UploadsService(mockConfigService);

    mockCreateSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: 'https://x.supabase.co/signed-put', path: 'x', token: 'tok' },
      error: null,
    });
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: 'https://x.supabase.co/public/x' } });
  });

  describe('role-gating (multipart.md §3.2)', () => {
    it('allows any authenticated user to request a profile-picture URL', async () => {
      const result = await service.createSignedUrl(
        { purpose: UploadPurpose.PROFILE_PICTURE, contentType: 'image/jpeg' },
        'user-1',
        ['user'],
      );
      expect(result).toEqual({ uploadUrl: 'https://x.supabase.co/signed-put', publicUrl: 'https://x.supabase.co/public/x' });
    });

    it('rejects a plain participant requesting an event-image URL', async () => {
      await expect(
        service.createSignedUrl({ purpose: UploadPurpose.EVENT_IMAGE, contentType: 'image/jpeg' }, 'user-1', ['user']),
      ).rejects.toThrow(ForbiddenException);
      expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('rejects a plain participant requesting a company-logo URL', async () => {
      await expect(
        service.createSignedUrl({ purpose: UploadPurpose.COMPANY_LOGO, contentType: 'image/jpeg' }, 'user-1', ['user']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows an organizer to request an event-cover URL', async () => {
      const result = await service.createSignedUrl(
        { purpose: UploadPurpose.EVENT_COVER, contentType: 'image/png' },
        'org-user-1',
        ['user', 'organizer'],
      );
      expect(result.uploadUrl).toBe('https://x.supabase.co/signed-put');
      expect(mockFrom).toHaveBeenCalledWith('event-images');
    });

    it('allows an admin to request a company-logo URL even without the organizer role', async () => {
      const result = await service.createSignedUrl(
        { purpose: UploadPurpose.COMPANY_LOGO, contentType: 'image/png' },
        'admin-1',
        ['admin'],
      );
      expect(result.uploadUrl).toBeDefined();
      expect(mockFrom).toHaveBeenCalledWith('organizer-logos');
    });
  });

  it('scopes the object path under the purpose prefix and the caller id, with a unique suffix', async () => {
    await service.createSignedUrl({ purpose: UploadPurpose.PROFILE_PICTURE, contentType: 'image/jpeg' }, 'user-42', ['user']);
    const path = mockCreateSignedUploadUrl.mock.calls[0][0] as string;
    expect(path).toMatch(/^users\/user-42\/[0-9a-f-]{36}\.jpg$/);
  });

  it('surfaces a Supabase error as an InternalServerErrorException', async () => {
    mockCreateSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'bucket not found' } });
    await expect(
      service.createSignedUrl({ purpose: UploadPurpose.PROFILE_PICTURE, contentType: 'image/jpeg' }, 'user-1', ['user']),
    ).rejects.toThrow(InternalServerErrorException);
  });

  describe('missing Supabase configuration (testing-bugs.txt #3)', () => {
    it('fails with a clear ServiceUnavailableException instead of the raw supabase-js error when SUPABASE_SERVICE_ROLE_KEY is unset', async () => {
      mockConfigService.get.mockImplementation((key: string) => (key === 'SUPABASE_URL' ? 'https://x.supabase.co' : undefined));

      await expect(
        service.createSignedUrl({ purpose: UploadPurpose.PROFILE_PICTURE, contentType: 'image/jpeg' }, 'user-1', ['user']),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockCreateSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('fails the same way when SUPABASE_URL is unset', async () => {
      mockConfigService.get.mockImplementation((key: string) => (key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'service-role-key' : undefined));

      await expect(
        service.createSignedUrl({ purpose: UploadPurpose.PROFILE_PICTURE, contentType: 'image/jpeg' }, 'user-1', ['user']),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('still checks the role gate before the config check', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      await expect(
        service.createSignedUrl({ purpose: UploadPurpose.EVENT_IMAGE, contentType: 'image/jpeg' }, 'user-1', ['user']),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
