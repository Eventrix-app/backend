import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { User } from '../entities/user.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailService } from '../email/email.service';

// Regression tests: reaching /auth/register in this app's flow always follows the full
// pre-auth onboarding chain (carousel + interests + location + notification prefs), so
// registration marks the account as onboarded; login must surface whatever the account's
// persisted value already is, unmodified.
describe('AuthService — hasCompletedOnboarding', () => {
  let service: AuthService;
  let mockUserRepo: jest.Mocked<any>;

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve({ id: 'user-1', ...data })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: {} },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: { send: jest.fn(), isConfigured: false } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('marks the new account as having completed onboarding', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      const result = await service.register({
        email: 'new@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
      } as any);

      expect(mockUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ hasCompletedOnboarding: true }),
      );
      expect(result.hasCompletedOnboarding).toBe(true);
    });
  });

  describe('login', () => {
    it('surfaces the account\'s persisted hasCompletedOnboarding value without altering it', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'existing@example.com',
        passwordHash: await bcrypt.hash('password123', 10),
        roles: ['user'],
        fullName: 'Existing User',
        isBanned: false,
        hasCompletedOnboarding: true,
      });

      const result = await service.login({ email: 'existing@example.com', password: 'password123' } as any);

      expect(result.hasCompletedOnboarding).toBe(true);
      expect(mockUserRepo.save).not.toHaveBeenCalled();
    });

    it('returns false for an account that never completed onboarding (e.g. admin-created)', async () => {
      mockUserRepo.findOne.mockResolvedValue({
        id: 'user-3',
        email: 'admincreated@example.com',
        passwordHash: await bcrypt.hash('password123', 10),
        roles: ['user'],
        fullName: 'Admin Created',
        isBanned: false,
        hasCompletedOnboarding: false,
      });

      const result = await service.login({ email: 'admincreated@example.com', password: 'password123' } as any);

      expect(result.hasCompletedOnboarding).toBe(false);
    });
  });
});
