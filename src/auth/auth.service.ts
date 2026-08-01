import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtPayload, SESSION_TOKEN_TTL_SECONDS } from './jwt.util';
import { burnPasswordCompare, hashPassword, needsRehash, verifyPassword } from './password.util';
import { User } from '../entities/user.entity';
import { AuthIdentity, AuthProvider } from '../entities/auth-identity.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailVerificationOtp } from '../entities/email-verification-otp.entity';
import { UserSession } from '../entities/user-session.entity';
import { CacheService } from '../common/cache/cache.service';
import { userMeCacheKey } from '../users/user-cache-keys';
import { EmailService } from '../email/email.service';
import {
  emailVerificationOtpEmail,
  passwordChangedEmail,
  passwordResetConfirmationEmail,
  passwordResetOtpEmail,
  welcomeEmail,
} from '../email/templates';

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];
const OTP_TTL_MINUTES = 10;

export interface SessionRecord {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  isCurrent: boolean;
}

// Precomputed bcrypt hash of a value no real password will ever equal — used to burn the
// same ~ms of CPU time login() spends on a real bcrypt.compare() when the email doesn't
// exist at all, so response time can't be used to distinguish "no such account" from
// "wrong password" (a login-page email-enumeration side channel).
const DUMMY_BCRYPT_HASH = '$2b$10$lrr0hTvMFpwzRSS1y5HAROh7xVeVje9kZFZQf58/Ea5GUWl8iIa5m';

// crypto.timingSafeEqual throws on unequal-length buffers rather than just returning
// false, so a naive early-return on length mismatch would itself reintroduce a (smaller,
// length-only) timing signal. Comparing the shorter buffer against itself keeps the
// unequal-length path costing roughly the same as an equal-length mismatch.
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Stateless — verifyIdToken() takes the audience list per call, so no single clientId
  // needs to be bound here despite the RN app using separate iOS/Android/Web client IDs.
  private readonly googleClient = new OAuth2Client();

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(PasswordResetOtp)
    private readonly otpRepository: Repository<PasswordResetOtp>,
    @InjectRepository(EmailVerificationOtp)
    private readonly emailVerificationOtpRepository: Repository<EmailVerificationOtp>,
    @InjectRepository(AuthIdentity)
    private readonly authIdentityRepository: Repository<AuthIdentity>,
    @InjectRepository(UserSession)
    private readonly sessionsRepository: Repository<UserSession>,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  // One row per login/register/social-login — its id becomes the token's `jti` claim, so
  // this specific session (and only this one) can later be revoked from Settings → Active
  // Sessions without invalidating the user's other logged-in devices.
  private async createSession(userId: string, deviceLabel?: string, userAgent?: string): Promise<string> {
    const session = this.sessionsRepository.create({
      userId,
      deviceLabel: deviceLabel || null,
      userAgent: userAgent || null,
      lastSeenAt: new Date(),
    });
    const saved = await this.sessionsRepository.save(session);
    return saved.id;
  }

  // Called on both password-change paths (self-service and forgot-password/OTP) — a
  // password change is exactly the moment a leaked/stolen session should stop working
  // everywhere, not just on whichever device made the change. This keeps Settings → Active
  // Sessions truthful with what JwtAuthGuard's own passwordChangedAt check already does
  // (silently reject every pre-existing token) — without it, a revoked-in-spirit session
  // would still show up as "active" in that list until its token separately expired.
  private async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionsRepository.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async login(loginDto: LoginDto, userAgent?: string): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      // Still run a bcrypt.compare so this path takes roughly the same time as a real
      // wrong-password rejection below — otherwise "no such account" returns near-instantly
      // while a real account's wrong password waits on bcrypt, letting an attacker enumerate
      // registered emails purely from response latency despite the identical error text.
      await burnPasswordCompare(password, DUMMY_BCRYPT_HASH);
      this.logger.warn(`Login failed: user not found for email ${email}`);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.isBanned) {
      this.logger.warn(`Login rejected: user ${email} is banned`);
      throw new UnauthorizedException('This account has been suspended');
    }

    const stored = user.passwordHash ?? '';
    const isLegacyPlaintext = !BCRYPT_PREFIXES.some((p) =>
      stored.startsWith(p),
    );

    let passwordMatches = false;
    if (isLegacyPlaintext) {
      // Legacy rows from the previous (unhashed) AuthService: compare plaintext and re-hash on success.
      // `===` on strings short-circuits at the first differing character, so its timing
      // leaks how many leading characters of a guess were correct — bcrypt.compare() below
      // doesn't have this problem, but these old plaintext rows predate it. Vanishingly few
      // (if any) such rows should still exist, but the comparison itself costs nothing to
      // harden properly.
      passwordMatches = timingSafeStringEqual(stored, password);
    } else {
      passwordMatches = await verifyPassword(password, stored, user.passwordHashVersion);
    }

    if (!passwordMatches) {
      this.logger.warn(`Login failed: password mismatch for email ${email}`);
      throw new UnauthorizedException('Invalid email or password');
    }

    // Transparent upgrade to the current hashing scheme. Login is the only place this can
    // happen — re-hashing needs the plaintext, and this is the one moment the server holds
    // it. Covers both the ancient unhashed rows above and v1 (unpeppered bcrypt) rows.
    //
    // Best-effort on purpose: a failure here means the account stays on the older scheme and
    // gets another chance next login. It must never turn a valid login into a failed one.
    if (isLegacyPlaintext || needsRehash(user.passwordHashVersion)) {
      try {
        const upgraded = await hashPassword(password);
        user.passwordHash = upgraded.hash;
        user.passwordHashVersion = upgraded.version;
        await this.usersRepository.save(user);
        this.logger.log(
          `Upgraded password hash for user ${user.email} to version ${upgraded.version}`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to upgrade password hash for ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const userRoles = user.roles?.length ? user.roles : ['user'];
    const sessionId = await this.createSession(user.id, loginDto.deviceLabel, userAgent);

    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      roles: userRoles,
      full_name: user.fullName || '',
      jti: sessionId,
    };

    const token = this.jwtService.sign(payload);

    return {
      accessToken: token,
      id: user.id,
      email: user.email,
      full_name: user.fullName || '',
      roles: userRoles,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      expiresIn: SESSION_TOKEN_TTL_SECONDS,
      profilePictureUrl: user.profilePictureUrl ?? null,
    };
  }

  async register(dto: CreateUserDto, userAgent?: string): Promise<AuthResponseDto> {
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const fullName = `${dto.firstName} ${dto.lastName}`.trim();
    const { hash: passwordHash, version: passwordHashVersion } = await hashPassword(dto.password);

    const username = dto.username || dto.email.split('@')[0];

    const user = this.usersRepository.create({
      email: dto.email,
      fullName,
      passwordHash,
      passwordHashVersion,
      dateOfBirth: dto.dateOfBirth,
      roles: ['user'],
      bio: JSON.stringify({ username }),
      isEmailVerified: false,
      // Registration now happens before the onboarding chain (carousel + interests +
      // location + notification prefs), not after — so a fresh account has not completed
      // it yet. Defaults to false via the entity/column default; PATCH
      // users/me/complete-onboarding flips it once the chain actually finishes.
    });

    const saved = await this.usersRepository.save(user);
    this.logger.log(`Registered new user: ${saved.email} (roles=${saved.roles})`);
    const welcome = welcomeEmail(dto.firstName);
    await this.emailService.send(saved.email, welcome.subject, welcome.html);

    const savedRoles = saved.roles?.length ? saved.roles : ['user'];
    const sessionId = await this.createSession(saved.id, dto.deviceLabel, userAgent);

    const payload: JwtPayload = {
      id: saved.id,
      email: saved.email,
      roles: savedRoles,
      full_name: saved.fullName || '',
      jti: sessionId,
    };

    const token = this.jwtService.sign(payload);

    return {
      accessToken: token,
      id: saved.id,
      email: saved.email,
      full_name: saved.fullName || '',
      roles: savedRoles,
      hasCompletedOnboarding: saved.hasCompletedOnboarding,
      expiresIn: SESSION_TOKEN_TTL_SECONDS,
      profilePictureUrl: saved.profilePictureUrl ?? null,
    };
  }

  // Re-issues a token with a fresh SESSION_TOKEN_TTL_SECONDS expiry for a user who already
  // holds a currently-valid one — JwtAuthGuard (which runs before this on every non-@Public()
  // route) has already verified the token's signature/expiry and that the account isn't
  // banned/deleted, so no password check is needed here. Re-reads the user row (rather than
  // trusting the old token's payload) so roles/name changes since the last login are picked
  // up on refresh instead of persisting stale claims for another 2 days.
  //
  // Reuses the SAME session (jti) rather than creating a new one — this is a sliding-TTL
  // renewal of an existing session (called on every app foreground/launch), not a new
  // login, so it must not spawn a fresh "device" entry in Settings → Active Sessions every
  // time. sessionId is undefined only for a pre-jti token (see JwtPayload.jti); such a
  // token refreshes untracked, same graceful-degradation as the guard's own check.
  async refresh(userId: string, sessionId?: string): Promise<AuthResponseDto> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    if (sessionId) {
      await this.sessionsRepository.update({ id: sessionId, userId }, { lastSeenAt: new Date() });
    }

    const userRoles = user.roles?.length ? user.roles : ['user'];
    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      roles: userRoles,
      full_name: user.fullName || '',
      jti: sessionId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      id: user.id,
      email: user.email,
      full_name: user.fullName || '',
      roles: userRoles,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      expiresIn: SESSION_TOKEN_TTL_SECONDS,
      profilePictureUrl: user.profilePictureUrl ?? null,
    };
  }

  async socialLogin(
    provider: 'google',
    token: string,
    deviceLabel?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // Verify the token with the provider and extract the user's profile. Each branch
    // cryptographically verifies the token against the provider itself (signature/audience/
    // issuer/expiry as applicable) rather than trusting whatever the client asserts.
    const { providerUserId, email, fullName, pictureUrl } = await this.verifyProviderToken(provider, token);

    // Find existing identity or create a new user
    let identity = await this.authIdentityRepository.findOne({
      where: { provider: provider as AuthProvider, providerUserId },
      relations: ['user'],
    });

    let user: User;
    if (identity) {
      user = identity.user;
    } else {
      // Check if a local account with this email already exists — link to it
      user = await this.usersRepository.findOne({ where: { email } }) ?? this.usersRepository.create({
        email,
        fullName: fullName ?? email.split('@')[0],
        profilePictureUrl: pictureUrl,
        roles: ['user'],
        isEmailVerified: true,
      });
      if (!user.id) {
        user = await this.usersRepository.save(user);
      }
      identity = this.authIdentityRepository.create({
        userId: user.id,
        provider: provider as AuthProvider,
        providerUserId,
        accessToken: token,
      });
      try {
        await this.authIdentityRepository.save(identity);
      } catch (err: any) {
        // Lost a concurrent double-tap/two-device race on the same (provider,
        // providerUserId) pair — AuthIdentity's unique constraint rejected the second
        // insert. The identity now exists (written by the other request), so re-fetch it
        // and continue logging in instead of surfacing a raw 500 to the loser.
        if (err?.code !== '23505') throw err;
        const existing = await this.authIdentityRepository.findOne({
          where: { provider: provider as AuthProvider, providerUserId },
          relations: ['user'],
        });
        if (!existing) throw err;
        identity = existing;
        user = existing.user;
      }
    }

    // Backfill the provider's avatar for an account that doesn't have one yet (e.g. an
    // existing email/password account linking a social identity for the first time, or one
    // created before this field was captured) — never overwrite a photo the user already set.
    if (!user.profilePictureUrl && pictureUrl) {
      user.profilePictureUrl = pictureUrl;
      user = await this.usersRepository.save(user);
    }

    if (user.isBanned) throw new UnauthorizedException('This account has been suspended');

    const userRoles = user.roles?.length ? user.roles : ['user'];
    const sessionId = await this.createSession(user.id, deviceLabel, userAgent);
    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      roles: userRoles,
      full_name: user.fullName || '',
      jti: sessionId,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      id: user.id,
      email: user.email,
      full_name: user.fullName || '',
      roles: userRoles,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      expiresIn: SESSION_TOKEN_TTL_SECONDS,
      profilePictureUrl: user.profilePictureUrl ?? null,
    };
  }

  private socialProfile(providerUserId: string, email: string, fullName?: string, pictureUrl?: string) {
    return { providerUserId, email, fullName, pictureUrl };
  }

  // Public wrapper around verifyGoogleToken below — used by socialLogin() and, separately,
  // by UsersService.eraseMyData() to re-verify a social-only account's identity (no password
  // to check) before honoring a data-erasure request.
  async verifyProviderToken(provider: 'google', token: string) {
    return this.verifyGoogleToken(token);
  }

  // Verifies a Google token — accepts both ID tokens (JWT, 3 dot-separated segments) and
  // access tokens (opaque ya29.xxx strings). ID tokens are verified cryptographically via
  // Google's JWKS and have their `aud` claim checked against our configured client IDs.
  // Access tokens (which expo-auth-session/providers/google returns when idToken is absent
  // in the native Android OAuth response) are verified by calling Google's userinfo
  // endpoint — Google only returns a valid profile if the token is genuine and unexpired.
  private async verifyGoogleToken(token: string) {
    const audience = [
      this.configService.get<string>('GOOGLE_CLIENT_ID_IOS'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_ANDROID'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_WEB'),
    ].filter((id): id is string => !!id);
    if (audience.length === 0) {
      this.logger.error('Google sign-in attempted but no GOOGLE_CLIENT_ID_* env vars are configured');
      throw new UnauthorizedException('Google sign-in is not configured on the server');
    }

    // A JWT has exactly 3 base64url segments separated by dots. Google access tokens
    // (ya29.xxx) are opaque strings that will never match this shape.
    const isIdToken = token.split('.').length === 3;

    if (isIdToken) {
      let payload: TokenPayload | undefined;
      try {
        const ticket = await this.googleClient.verifyIdToken({ idToken: token, audience });
        payload = ticket.getPayload();
      } catch (err) {
        this.logger.warn(`Google token verification failed: ${err instanceof Error ? err.message : String(err)}`);
        throw new UnauthorizedException('Invalid Google token');
      }
      if (!payload?.sub || !payload.email) throw new UnauthorizedException('Invalid Google token');
      return this.socialProfile(payload.sub, payload.email, payload.name, payload.picture);
    }

    // Access token path — validate by asking Google's userinfo endpoint directly.
    // If the token is expired, revoked, or fabricated, Google returns a 4xx.
    let userInfo: { sub?: string; email?: string; name?: string; picture?: string };
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`userinfo HTTP ${res.status}`);
      userInfo = (await res.json()) as typeof userInfo;
    } catch (err) {
      this.logger.warn(`Google access token userinfo fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid Google token');
    }
    if (!userInfo.sub || !userInfo.email) throw new UnauthorizedException('Invalid Google token');
    return this.socialProfile(userInfo.sub, userInfo.email, userInfo.name, userInfo.picture);
  }

  // SHA-256 of the plaintext OTP — the code itself only ever exists in the email sent to
  // the user and transiently in this process; the DB only ever holds the digest.
  private hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      this.logger.log(`ForgotPassword requested for non-existent email: ${email}`);
      return;
    }

    // crypto.randomInt is uniform over [100000, 999999] and, unlike Math.random(), isn't
    // predictable from observing prior outputs — worth the negligible extra cost for
    // something that gates an account takeover.
    const otp = randomInt(100000, 1000000).toString();

    // One pending OTP per email — a fresh request supersedes whatever was issued before,
    // matching the old Map's single-entry-per-key behavior.
    await this.otpRepository.delete({ email });
    await this.otpRepository.save(
      this.otpRepository.create({
        email,
        otpHash: this.hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      }),
    );

    const otpEmail = passwordResetOtpEmail(otp, OTP_TTL_MINUTES);
    await this.emailService.send(email, otpEmail.subject, otpEmail.html);

    // Local-dev convenience only, and only when no real send was attempted — once email is
    // configured, the code must never also land in a log, or "send it privately" is moot.
    // Also requires the same explicit ALLOW_DEV_OTP_BYPASS opt-in as the bypass below —
    // email being unconfigured is not, by itself, proof this is a local dev environment;
    // env.validation.ts makes RESEND_API_KEY/SMTP_* all optional, so a production
    // deployment that simply forgot to set them would otherwise silently leak
    // account-takeover-capable OTPs to its logs.
    const allowDevOtpLogging = this.configService.get<string>('ALLOW_DEV_OTP_BYPASS') === 'true';
    if (!this.emailService.isConfigured && allowDevOtpLogging) {
      this.logger.log(`*************************************************`);
      this.logger.log(`PASSWORD RESET OTP FOR ${email}: ${otp}`);
      this.logger.log(`*************************************************`);
    }
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const now = new Date();
    let match = await this.otpRepository.findOne({
      where: { otpHash: this.hashOtp(token), expiresAt: MoreThan(now) },
      order: { createdAt: 'DESC' },
    });

    // Dev-only testing fallback (matches whichever OTP was most recently issued, for
    // whichever email that was) — exists so a local tester without email configured can
    // drive the reset flow without tailing server logs. Fails CLOSED: requires an explicit
    // opt-in env var, rather than inferring "not production" from NODE_ENV — NODE_ENV isn't
    // required/validated anywhere in this app (env.validation.ts), so gating on `!==
    // 'production'` meant this account-takeover-shaped bypass would be silently *live* on
    // any deployment (VM, Docker, etc.) that simply never set NODE_ENV, not just genuine
    // local dev. An unset/misconfigured env now leaves this off by default instead of on.
    const allowDevOtpBypass = this.configService.get<string>('ALLOW_DEV_OTP_BYPASS') === 'true';
    if (!match && token === '123456' && allowDevOtpBypass) {
      match = await this.otpRepository.findOne({
        where: { expiresAt: MoreThan(now) },
        order: { createdAt: 'DESC' },
      });
    }

    if (!match) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const user = await this.usersRepository.findOne({ where: { email: match.email } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const resetHash = await hashPassword(password);
    user.passwordHash = resetHash.hash;
    user.passwordHashVersion = resetHash.version;
    user.passwordChangedAt = new Date();
    await this.usersRepository.save(user);
    await this.otpRepository.delete({ email: match.email });
    await this.revokeAllSessions(user.id);
    this.logger.log(`Password reset successfully for user: ${match.email}`);
    await this.sendPasswordResetEmail(match.email);
  }

  // Self-service, logged-in only (Settings/Profile "Verify email" action) — unlike
  // forgot-password, there's no unauthenticated path here, so no email-enumeration concern
  // and no need to silently no-op on a missing account the way forgotPassword does.
  async sendEmailVerificationOtp(userId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    const otp = randomInt(100000, 1000000).toString();

    // One pending OTP per email, same as the password-reset flow.
    await this.emailVerificationOtpRepository.delete({ email: user.email });
    await this.emailVerificationOtpRepository.save(
      this.emailVerificationOtpRepository.create({
        email: user.email,
        otpHash: this.hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      }),
    );

    const otpEmail = emailVerificationOtpEmail(otp, OTP_TTL_MINUTES);
    await this.emailService.send(user.email, otpEmail.subject, otpEmail.html);

    // Same explicit ALLOW_DEV_OTP_BYPASS gate as forgotPassword() — see that comment.
    const allowDevOtpLogging = this.configService.get<string>('ALLOW_DEV_OTP_BYPASS') === 'true';
    if (!this.emailService.isConfigured && allowDevOtpLogging) {
      this.logger.log(`*************************************************`);
      this.logger.log(`EMAIL VERIFICATION OTP FOR ${user.email}: ${otp}`);
      this.logger.log(`*************************************************`);
    }
  }

  async confirmEmailVerification(userId: string, otp: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    const now = new Date();
    let match = await this.emailVerificationOtpRepository.findOne({
      where: { email: user.email, otpHash: this.hashOtp(otp), expiresAt: MoreThan(now) },
      order: { createdAt: 'DESC' },
    });

    // Same dev-only bypass as resetPassword, scoped to this user's own pending OTP only.
    const allowDevOtpBypass = this.configService.get<string>('ALLOW_DEV_OTP_BYPASS') === 'true';
    if (!match && otp === '123456' && allowDevOtpBypass) {
      match = await this.emailVerificationOtpRepository.findOne({
        where: { email: user.email, expiresAt: MoreThan(now) },
        order: { createdAt: 'DESC' },
      });
    }

    if (!match) {
      // Deliberately 400, not 401: this endpoint is already authenticated (JwtAuthGuard),
      // so a wrong/expired OTP is a bad-input error, not a session problem. The frontend's
      // authErrorMiddleware force-logs-out on any 401 from any endpoint — a 401 here would
      // kick the user back to the splash screen instead of showing the error on this screen.
      throw new BadRequestException('Invalid or expired verification code');
    }

    user.isEmailVerified = true;
    await this.usersRepository.save(user);
    await this.emailVerificationOtpRepository.delete({ email: user.email });
    // Shares users:me:<id> with UsersService.findMe — bust it or the profile screen would
    // keep showing isEmailVerified: false for the cache's remaining TTL.
    await this.cache.del(userMeCacheKey(userId));
    this.logger.log(`Email verified for user: ${user.email}`);
  }

  // Logged-in password change (vs. resetPassword's forgot-password/OTP flow) — requires
  // proving the current password rather than a code, so it uses UnauthorizedException the
  // same way login does for a bad credential.
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const matches = await verifyPassword(currentPassword, user.passwordHash ?? '', user.passwordHashVersion);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const changed = await hashPassword(newPassword);
    user.passwordHash = changed.hash;
    user.passwordHashVersion = changed.version;
    user.passwordChangedAt = new Date();
    await this.usersRepository.save(user);
    await this.revokeAllSessions(user.id);
    this.logger.log(`Password changed for user: ${user.email}`);
    await this.sendPasswordChangedEmail(user.email);
  }

  // Logged-in self-service change — the account owner proved they know the current
  // password, so this is lower-suspicion than a reset, but still worth a notice.
  private async sendPasswordChangedEmail(email: string): Promise<void> {
    const changed = passwordChangedEmail();
    await this.emailService.send(email, changed.subject, changed.html);
  }

  // Forgot-password/OTP flow — doesn't require proving the current password, so this is
  // the higher-suspicion path (anyone who intercepted the OTP could trigger it). Worded
  // and flagged distinctly from sendPasswordChangedEmail so a recipient who didn't request
  // a reset immediately recognizes this as the more serious of the two notices.
  private async sendPasswordResetEmail(email: string): Promise<void> {
    const resetConfirmation = passwordResetConfirmationEmail();
    await this.emailService.send(email, resetConfirmation.subject, resetConfirmation.html);
  }

  // --- Session management (Settings → Active Sessions) ---

  async listSessions(userId: string, currentSessionId?: string): Promise<SessionRecord[]> {
    const sessions = await this.sessionsRepository.find({
      where: { userId, revokedAt: IsNull() },
      order: { lastSeenAt: 'DESC' },
    });
    return sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel ?? null,
      userAgent: s.userAgent ?? null,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      isCurrent: s.id === currentSessionId,
    }));
  }

  // Deliberately silent (no error) if the session doesn't exist or was already revoked —
  // "log out this device" reaching the same end state either way isn't worth surfacing as
  // a failure to the caller. The `userId` scoping in the WHERE is what actually matters:
  // it's what stops one account from revoking another's session by guessing an id.
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.sessionsRepository.update({ id: sessionId, userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  // "Log out other devices" — revokes every one of this user's active sessions except the
  // one making the request. If the caller's own token predates the jti field (see
  // JwtPayload.jti), there's no "current" session id to protect, so every session is
  // revoked, including — on its next request — the caller's own; that's the correct
  // outcome for a token this app can't otherwise distinguish from any other device's.
  async revokeOtherSessions(userId: string, currentSessionId?: string): Promise<number> {
    const result = await this.sessionsRepository.update(
      { userId, revokedAt: IsNull(), id: Not(currentSessionId ?? '') },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }
}
