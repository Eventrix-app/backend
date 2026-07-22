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
  let mockEmailService: jest.Mocked<any>;

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve({ id: 'user-1', ...data })),
    };
    mockEmailService = { send: jest.fn().mockResolvedValue(undefined), isConfigured: false };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: {} },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: mockEmailService },
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

    it('sends a welcome email to the new account', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await service.register({
        email: 'new@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
      } as any);

      expect(mockEmailService.send).toHaveBeenCalledWith(
        'new@example.com',
        expect.stringContaining('Welcome'),
        expect.any(String),
      );
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

// Regression tests: both the forgot-password/OTP flow and the logged-in change-password
// flow must email the account owner a security notice (distinctly worded per flow) —
// previously silent on both paths.
describe('AuthService — password change/reset security emails', () => {
  let service: AuthService;
  let mockUserRepo: jest.Mocked<any>;
  let mockOtpRepo: jest.Mocked<any>;
  let mockEmailService: jest.Mocked<any>;

  beforeEach(async () => {
    mockUserRepo = { findOne: jest.fn(), save: jest.fn((u: any) => Promise.resolve(u)) };
    mockOtpRepo = { findOne: jest.fn(), delete: jest.fn() };
    mockEmailService = { send: jest.fn().mockResolvedValue(undefined), isConfigured: true };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: mockOtpRepo },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('emails the user after a successful changePassword()', async () => {
    mockUserRepo.findOne.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: await bcrypt.hash('oldpass123', 10),
    });

    await service.changePassword('user-1', 'oldpass123', 'newpass456');

    expect(mockEmailService.send).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('password was changed'),
      expect.any(String),
    );
  });

  it('emails the user after a successful resetPassword()', async () => {
    mockOtpRepo.findOne.mockResolvedValue({
      email: 'user@example.com',
      otpHash: 'irrelevant',
      expiresAt: new Date(Date.now() + 60000),
    });
    mockUserRepo.findOne.mockResolvedValue({ id: 'user-1', email: 'user@example.com' });

    await service.resetPassword('123456', 'newpass456');

    expect(mockEmailService.send).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('password was reset'),
      expect.any(String),
    );
  });
});
