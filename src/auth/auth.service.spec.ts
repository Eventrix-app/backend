import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { hashPassword } from './password.util';
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
        phoneNumber: '9876543210',
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
        phoneNumber: '9876543210',
      } as any);

      expect(mockEmailService.send).toHaveBeenCalledWith(
        'new@example.com',
        expect.stringContaining('Welcome'),
        expect.any(String),
      );
    });

    // The point of collecting a number at signup is that checkout never has to ask, which
    // only holds if what is stored is what PayU will accept.
    it.each([
      ['+91 98765 43210', '9876543210'],
      ['098765-43210', '9876543210'],
      ['9876543210', '9876543210'],
    ])('stores %s normalised as %s', async (input, expected) => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await service.register({
        email: 'new@example.com',
        password: 'password123',
        firstName: 'New',
        lastName: 'User',
        phoneNumber: input,
      } as any);

      expect(mockUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ phoneNumber: expected }),
      );
    });

    it('refuses a number that cannot be a 10-digit subscriber number', async () => {
      mockUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.register({
          email: 'new@example.com',
          password: 'password123',
          firstName: 'New',
          lastName: 'User',
          phoneNumber: '12345',
        } as any),
      ).rejects.toThrow(BadRequestException);
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
      // This fixture has no passwordHashVersion, i.e. a pre-pepper account, so login does
      // legitimately write to it — to upgrade the hash. Asserting save() was never called
      // was only ever a proxy for what this test is actually about; assert that directly
      // instead, so the onboarding flag is checked rather than the absence of any write.
      for (const [saved] of mockUserRepo.save.mock.calls) {
        expect(saved.hasCompletedOnboarding).toBe(true);
      }
    });

    it('transparently upgrades a pre-pepper password hash on successful login', async () => {
      // Existing accounts cannot be migrated in bulk — converting a v1 hash to v2 needs the
      // plaintext, which only exists at login. This is the whole migration strategy, so it
      // has to actually fire.
      const user = {
        id: 'user-legacy',
        email: 'legacy@example.com',
        passwordHash: await bcrypt.hash('password123', 10),
        passwordHashVersion: 1,
        roles: ['user'],
        fullName: 'Legacy User',
        isBanned: false,
        hasCompletedOnboarding: true,
      };
      mockUserRepo.findOne.mockResolvedValue(user);
      // Captured before login: the service upgrades the entity in place, so by the time the
      // assertions run `user.passwordHash` is already the new value and comparing against it
      // would compare the string to itself.
      const originalHash = user.passwordHash;

      await service.login({ email: 'legacy@example.com', password: 'password123' } as any);

      expect(mockUserRepo.save).toHaveBeenCalled();
      const [saved] = mockUserRepo.save.mock.calls[0];
      expect(saved.passwordHashVersion).toBe(2);
      // Re-hashed, not merely relabelled — a version bump without a new hash would lock the
      // account out on its next login.
      expect(saved.passwordHash).not.toBe(originalHash);
    });

    it('does not rewrite a hash that is already on the current version', async () => {
      const current = await hashPassword('password123');
      mockUserRepo.findOne.mockResolvedValue({
        id: 'user-current',
        email: 'current@example.com',
        passwordHash: current.hash,
        passwordHashVersion: current.version,
        roles: ['user'],
        fullName: 'Current User',
        isBanned: false,
        hasCompletedOnboarding: true,
      });

      await service.login({ email: 'current@example.com', password: 'password123' } as any);

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

// Regression tests: an unconfigured EmailService alone must not be enough to leak a
// password-reset OTP into the server logs — that also requires the explicit
// ALLOW_DEV_OTP_BYPASS opt-in, the same gate the "123456" dev bypass code already
// requires, since env.validation.ts leaves RESEND_API_KEY/SMTP_* fully optional and a
// production deploy could otherwise "accidentally" leave email unconfigured.
describe('AuthService — OTP cleartext logging gate', () => {
  let service: AuthService;
  let mockUserRepo: jest.Mocked<any>;
  let mockOtpRepo: jest.Mocked<any>;
  let mockConfigService: jest.Mocked<any>;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    mockUserRepo = { findOne: jest.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.com' }) };
    mockOtpRepo = {
      delete: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((d: any) => d),
    };
    mockConfigService = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(PasswordResetOtp), useValue: mockOtpRepo },
        { provide: getRepositoryToken(EmailVerificationOtp), useValue: {} },
        { provide: getRepositoryToken(AuthIdentity), useValue: {} },
        { provide: getRepositoryToken(UserSession), useValue: makeMockSessionRepo() },
        { provide: JwtService, useValue: { sign: jest.fn(() => 'signed-token') } },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined), isConfigured: false } },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: CacheService, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    logSpy = jest.spyOn((service as any).logger, 'log');
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('does not log the OTP when ALLOW_DEV_OTP_BYPASS is unset, even with email unconfigured', async () => {
    mockConfigService.get.mockReturnValue(undefined);

    await service.forgotPassword('user@example.com');

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('PASSWORD RESET OTP'))).toBe(false);
  });

  it('logs the OTP only when ALLOW_DEV_OTP_BYPASS is explicitly set to "true"', async () => {
    mockConfigService.get.mockReturnValue('true');

    await service.forgotPassword('user@example.com');

    expect(logSpy.mock.calls.some((call) => String(call[0]).includes('PASSWORD RESET OTP'))).toBe(true);
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
