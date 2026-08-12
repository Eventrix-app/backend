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

// Burns the same CPU as a real bcrypt.compare when the email doesn't exist, so response
// time can't distinguish "no such account" from "wrong password".
const DUMMY_BCRYPT_HASH = '$2b$10$lrr0hTvMFpwzRSS1y5HAROh7xVeVje9kZFZQf58/Ea5GUWl8iIa5m';

// timingSafeEqual throws on unequal lengths, so an early return would leak a length signal.
// Comparing the shorter buffer against itself keeps both paths costing the same.
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

  // One row per login — its id becomes the token's `jti`, so this session alone can be
  // revoked from Active Sessions without logging out the user's other devices.
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

  // A password change must kill sessions everywhere, not just on the device that made it.
  // Keeps Active Sessions truthful with JwtAuthGuard's passwordChangedAt check.
  private async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionsRepository.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async login(loginDto: LoginDto, userAgent?: string): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      // Run bcrypt anyway so this costs the same as a real wrong-password rejection —
      // otherwise response latency enumerates registered emails despite identical text.
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
      // Legacy unhashed rows: `===` short-circuits and leaks how many leading characters
      // matched, so compare in constant time even though these rows are near-extinct.
      passwordMatches = timingSafeStringEqual(stored, password);
    } else {
      passwordMatches = await verifyPassword(password, stored, user.passwordHashVersion);
    }

    if (!passwordMatches) {
      this.logger.warn(`Login failed: password mismatch for email ${email}`);
      throw new UnauthorizedException('Invalid email or password');
    }

    // Login is the only place re-hashing can happen — it needs the plaintext. Best-effort:
    // a failure leaves the older scheme in place and must never fail a valid login.
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
      // Registration now precedes onboarding, so a fresh account has not completed it.
      // PATCH users/me/complete-onboarding flips this once the chain finishes.
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

  // Sliding-TTL renewal for an already-valid token, so it reuses the SAME jti rather than
  // spawning a new Active Sessions entry. Re-reads the user so role changes aren't stale.
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
    // Each branch verifies the token against the provider itself (signature/audience/issuer)
    // rather than trusting what the client asserts.
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
        // Lost a double-tap race on the same (provider, providerUserId) — the identity now
        // exists, so re-fetch and continue instead of surfacing a 500 to the loser.
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

    // Backfill the provider avatar only when the account has none — never overwrite a photo
    // the user set themselves.
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

  // Public wrapper used by socialLogin() and by UsersService.eraseMyData() to re-verify a
  // social-only account before honoring erasure.
  async verifyProviderToken(provider: 'google', token: string) {
    return this.verifyGoogleToken(token);
  }

  // Accepts ID tokens (verified via Google's JWKS with an `aud` check) and opaque access
  // tokens (verified via userinfo), since native Android OAuth omits the idToken.
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

    // crypto.randomInt is uniform and unpredictable from prior outputs, unlike Math.random()
    // — worth it for something that gates account takeover.
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

    // Requires the same explicit opt-in as the bypass below: email being unconfigured does
    // not prove local dev, so a prod deploy missing SMTP would leak OTPs to its logs.
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

    // Dev-only reset bypass. Fails CLOSED behind an explicit env var rather than NODE_ENV,
    // which is never validated here — gating on it would leave this live wherever it is unset.
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

  // Logged-in only, so unlike forgot-password there is no enumeration concern and no need
  // to silently no-op on a missing account.
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
      // 400, not 401: the endpoint is already authenticated, and the frontend force-logs-out
      // on any 401 — which would bounce the user to splash instead of showing the error.
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

  // Logged-in change requires the current password rather than a code, so it uses
  // UnauthorizedException the same way login does.
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

  // Forgot-password path proves no current password, so it is the higher-suspicion one —
  // worded distinctly so a recipient who didn't request it recognises the severity.
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

  // Silent when already revoked — same end state either way. The userId scoping in the
  // WHERE is what stops one account revoking another's session by guessing an id.
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.sessionsRepository.update({ id: sessionId, userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  // Revokes every session except the caller's. A pre-jti token has no id to protect, so it
  // revokes its own too — correct for a token this app can't distinguish from any other.
  async revokeOtherSessions(userId: string, currentSessionId?: string): Promise<number> {
    const result = await this.sessionsRepository.update(
      { userId, revokedAt: IsNull(), id: Not(currentSessionId ?? '') },
      { revokedAt: new Date() },
    );
    return result.affected ?? 0;
  }
}
