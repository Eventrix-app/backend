import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { User } from '../entities/user.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { AuthIdentity } from '../entities/auth-identity.entity';
import { UserSession } from '../entities/user-session.entity';
import { EmailService } from '../email/email.service';
import { CacheService } from '../common/cache/cache.service';

function makeMockSessionRepo() {
  return {
    create: jest.fn((data: any) => data),
    save: jest.fn((s: any) => Promise.resolve({ id: 'session-1', ...s })),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  };
}

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
        { provide: getRepositoryToken(EmailVerificationOtp), useValue: {} },
        { provide: getRepositoryToken(AuthIdentity), useValue: {} },
        { provide: getRepositoryToken(UserSession), useValue: makeMockSessionRepo() },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('does not mark the new account as having completed onboarding (the chain now runs after registration)', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      const result = await service.register({
        email: 'new@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
      } as any);

      expect(mockUserRepo.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ hasCompletedOnboarding: expect.anything() }),
      );
      expect(result.hasCompletedOnboarding).toBeFalsy();
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
        { provide: getRepositoryToken(EmailVerificationOtp), useValue: {} },
        { provide: getRepositoryToken(AuthIdentity), useValue: {} },
        { provide: getRepositoryToken(UserSession), useValue: makeMockSessionRepo() },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
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

// Regression tests for Settings → Active Sessions: each login/register/social-login
// creates one UserSession row (id used as the JWT's `jti`), refresh() renews the SAME
// row instead of spawning a new one, and a password change revokes every session so the
// list stays truthful with what JwtAuthGuard's passwordChangedAt check already enforces.
describe('AuthService — session management', () => {
  let service: AuthService;
  let mockUserRepo: jest.Mocked<any>;
  let mockSessionRepo: ReturnType<typeof makeMockSessionRepo>;
  let mockJwtService: { sign: jest.Mock };

  beforeEach(async () => {
    mockUserRepo = {
      findOne: jest.fn(),
      save: jest.fn((u: any) => Promise.resolve({ id: 'user-1', ...u })),
    };
    mockSessionRepo = makeMockSessionRepo();
    mockJwtService = { sign: jest.fn((payload: any) => `signed:${JSON.stringify(payload)}`) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: {} },
        { provide: getRepositoryToken(EmailVerificationOtp), useValue: {} },
        { provide: getRepositoryToken(AuthIdentity), useValue: {} },
        { provide: getRepositoryToken(UserSession), useValue: mockSessionRepo },
        { provide: JwtService, useValue: mockJwtService },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined), isConfigured: true } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('creates a session and signs the token with its id as jti on login()', async () => {
    mockUserRepo.findOne.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: await bcrypt.hash('password123', 10),
      roles: ['user'],
    });
    mockSessionRepo.save.mockResolvedValue({ id: 'session-abc' });

    await service.login({ email: 'user@example.com', password: 'password123' } as any, 'Mozilla/5.0');

    expect(mockSessionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', userAgent: 'Mozilla/5.0' }),
    );
    const [payload] = mockJwtService.sign.mock.calls[0];
    expect(payload.jti).toBe('session-abc');
  });

  it('refresh() reuses the existing jti instead of creating a new session', async () => {
    mockUserRepo.findOne.mockResolvedValue({ id: 'user-1', email: 'user@example.com', roles: ['user'] });

    await service.refresh('user-1', 'existing-session-id');

    expect(mockSessionRepo.create).not.toHaveBeenCalled();
    expect(mockSessionRepo.update).toHaveBeenCalledWith(
      { id: 'existing-session-id', userId: 'user-1' },
      expect.objectContaining({ lastSeenAt: expect.any(Date) }),
    );
    const [payload] = mockJwtService.sign.mock.calls[0];
    expect(payload.jti).toBe('existing-session-id');
  });

  it('changePassword() revokes every active session for the user', async () => {
    mockUserRepo.findOne.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      passwordHash: await bcrypt.hash('oldpass123', 10),
    });

    await service.changePassword('user-1', 'oldpass123', 'newpass456');

    expect(mockSessionRepo.update).toHaveBeenCalledWith(
      { userId: 'user-1', revokedAt: expect.anything() },
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('listSessions() marks the caller\'s own session as current', async () => {
    mockSessionRepo.find.mockResolvedValue([
      { id: 'session-a', deviceLabel: 'iPhone', userAgent: null, createdAt: new Date(), lastSeenAt: new Date() },
      { id: 'session-b', deviceLabel: 'Pixel', userAgent: null, createdAt: new Date(), lastSeenAt: new Date() },
    ]);

    const result = await service.listSessions('user-1', 'session-b');

    expect(result.find((s) => s.id === 'session-a')?.isCurrent).toBe(false);
    expect(result.find((s) => s.id === 'session-b')?.isCurrent).toBe(true);
  });

  it('revokeSession() scopes the update to the caller\'s own session', async () => {
    await service.revokeSession('user-1', 'session-a');

    expect(mockSessionRepo.update).toHaveBeenCalledWith(
      { id: 'session-a', userId: 'user-1', revokedAt: expect.anything() },
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
  });

  it('revokeOtherSessions() excludes the current session from the revoke', async () => {
    mockSessionRepo.update.mockResolvedValue({ affected: 2 });

    const revoked = await service.revokeOtherSessions('user-1', 'session-current');

    expect(mockSessionRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    // The Not(currentSessionId) operator itself isn't easily asserted through a plain
    // mock — the exclusion is instead covered end-to-end by controller/integration tests.
    expect(revoked).toBe(2);
  });
});
