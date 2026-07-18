import { ConflictException } from '@nestjs/common';
import { ParticipantService } from './participant.service';
import { CreateParticipantDto } from './dto/create-participant.dto';

describe('ParticipantService', () => {
  let service: ParticipantService;
  let mockUsersRepo: any;
  let mockCategoryRepo: any;
  let mockJwtService: any;
  let mockCacheService: any;

  const dto: CreateParticipantDto = {
    username: 'newuser',
    email: 'new@example.com',
    password: 'Password123!',
    firstName: 'New',
    lastName: 'User',
    gender: 'Male',
    dateOfBirth: '1995-01-01',
    phone: '9999999999',
    addressType: 'Residential',
    addressLine: '123 Main St',
    city: 'City',
    state: 'State',
    country: 'Country',
    pincode: '12345',
    profileImageUrl: undefined as any,
    isActive: true,
  };

  beforeEach(() => {
    mockUsersRepo = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) =>
        Promise.resolve({ id: 'user-1', createdAt: new Date(), updatedAt: new Date(), ...data }),
      ),
    };
    mockCategoryRepo = {};
    mockJwtService = { sign: jest.fn(() => 'signed.jwt.token') };
    mockCacheService = { get: jest.fn(), set: jest.fn(), del: jest.fn(), getVersion: jest.fn(), bumpVersion: jest.fn() };
    service = new ParticipantService(mockUsersRepo, mockCategoryRepo, mockJwtService, mockCacheService);
  });

  // Regression test for testing-bugs.txt #2: POST /participants creates the same kind
  // of account as POST /auth/register and must be equally usable afterward, not force
  // a separate login.
  describe('create', () => {
    it('returns an accessToken so the new account is immediately usable, same as POST /auth/register', async () => {
      mockUsersRepo.findOne.mockResolvedValue(null);

      const result = await service.create(dto);

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email, roles: ['user'] }),
      );
    });

    it('rejects registration with an email that already exists', async () => {
      mockUsersRepo.findOne.mockResolvedValue({ id: 'existing-user' });

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(mockUsersRepo.save).not.toHaveBeenCalled();
    });
  });
});
