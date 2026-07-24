import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import appleSignin from 'apple-signin-auth';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtPayload, SESSION_TOKEN_TTL_SECONDS } from './jwt.util';
import { User } from '../entities/user.entity';
import { AuthIdentity, AuthProvider } from '../entities/auth-identity.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailService } from '../email/email.service';
import {
  passwordChangedEmail,
  passwordResetConfirmationEmail,
  passwordResetOtpEmail,
  welcomeEmail,
} from '../email/templates';

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];
const BCRYPT_ROUNDS = 10;
const OTP_TTL_MINUTES = 10;

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
    @InjectRepository(AuthIdentity)
    private readonly authIdentityRepository: Repository<AuthIdentity>,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      // Still run a bcrypt.compare so this path takes roughly the same time as a real
      // wrong-password rejection below — otherwise "no such account" returns near-instantly
      // while a real account's wrong password waits on bcrypt, letting an attacker enumerate
      // registered emails purely from response latency despite the identical error text.
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
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
      if (passwordMatches) {
        try {
          user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
          await this.usersRepository.save(user);
          this.logger.log(`Re-hashed legacy password for user ${user.email}`);
        } catch (err) {
          this.logger.warn(
            `Failed to upgrade legacy password for ${user.email}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else {
      passwordMatches = await bcrypt.compare(password, stored);
    }

    if (!passwordMatches) {
      this.logger.warn(`Login failed: password mismatch for email ${email}`);
      throw new UnauthorizedException('Invalid email or password');
    }

    const userRoles = user.roles?.length ? user.roles : ['user'];

    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      roles: userRoles,
      full_name: user.fullName || '',
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

  async register(dto: CreateUserDto): Promise<AuthResponseDto> {
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const fullName = `${dto.firstName} ${dto.lastName}`.trim();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const username = dto.username || dto.email.split('@')[0];

    const user = this.usersRepository.create({
      email: dto.email,
      fullName,
      passwordHash,
      roles: ['user'],
      bio: JSON.stringify({ username }),
      isEmailVerified: false,
      isPhoneVerified: false,
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

    const payload: JwtPayload = {
      id: saved.id,
      email: saved.email,
      roles: savedRoles,
      full_name: saved.fullName || '',
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
  async refresh(userId: string): Promise<AuthResponseDto> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const userRoles = user.roles?.length ? user.roles : ['user'];
    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      roles: userRoles,
      full_name: user.fullName || '',
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

  async socialLogin(provider: 'google' | 'apple' | 'facebook', token: string): Promise<AuthResponseDto> {
    // Verify the token with the provider and extract the user's profile. Each branch
    // cryptographically verifies the token against the provider itself (signature/audience/
    // issuer/expiry as applicable) rather than trusting whatever the client asserts.
    const { providerUserId, email, fullName, pictureUrl } =
      provider === 'google'
        ? await this.verifyGoogleToken(token)
        : provider === 'apple'
          ? await this.verifyAppleToken(token)
          : await this.verifyFacebookToken(token);

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
        isPhoneVerified: false,
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
      await this.authIdentityRepository.save(identity);
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
    const payload: JwtPayload = { id: user.id, email: user.email, roles: userRoles, full_name: user.fullName || '' };
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

  // Verifies the ID token's signature, issuer and expiry via Google's own JWKS (handled
  // internally by google-auth-library) and — critically — checks the `aud` claim against
  // one of *our* configured client IDs. Without the audience check, any valid Google ID
  // token issued for any app on Earth would pass verification.
  private async verifyGoogleToken(idToken: string) {
    const audience = [
      this.configService.get<string>('GOOGLE_CLIENT_ID_IOS'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_ANDROID'),
      this.configService.get<string>('GOOGLE_CLIENT_ID_WEB'),
    ].filter((id): id is string => !!id);
    if (audience.length === 0) {
      this.logger.error('Google sign-in attempted but no GOOGLE_CLIENT_ID_* env vars are configured');
      throw new UnauthorizedException('Google sign-in is not configured on the server');
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Google token verification failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid Google token');
    }
    if (!payload?.sub || !payload.email) throw new UnauthorizedException('Invalid Google token');
    return this.socialProfile(payload.sub, payload.email, payload.name, payload.picture);
  }

  // apple-signin-auth's verifyIdToken fetches Apple's public keys and verifies the JWT's
  // signature/issuer/expiry — real cryptographic verification, unlike the previous
  // implementation which only base64-decoded the payload without checking the signature at
  // all. `audience` is only enforced when APPLE_CLIENT_ID is configured: Sign in with Apple
  // isn't wired up client-side yet (no bundle/services ID has been issued), so we still
  // verify every other claim rather than rejecting the whole provider outright.
  private async verifyAppleToken(idToken: string) {
    const audience = this.configService.get<string>('APPLE_CLIENT_ID') || undefined;
    let payload: Awaited<ReturnType<typeof appleSignin.verifyIdToken>>;
    try {
      payload = await appleSignin.verifyIdToken(idToken, audience ? { audience } : undefined);
    } catch (err) {
      this.logger.warn(`Apple token verification failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid Apple token');
    }
    if (!payload?.sub) throw new UnauthorizedException('Invalid Apple token');
    return this.socialProfile(
      payload.sub,
      payload.email ?? `${payload.sub}@privaterelay.appleid.com`,
      undefined,
    );
  }

  // Facebook has no signed-JWT equivalent — the access token is an opaque string, so it
  // must be verified by asking Facebook's own Graph API about it (debug_token), rather than
  // trusting the client's claimed provider/token pairing. appsecret_proof additionally
  // proves the /me call itself originates from a party holding our app secret, per Meta's
  // recommended hardening: https://developers.facebook.com/docs/graph-api/securing-requests
  private async verifyFacebookToken(token: string) {
    const appId = this.configService.get<string>('FACEBOOK_APP_ID');
    const appSecret = this.configService.get<string>('FACEBOOK_APP_SECRET');
    if (!appId || !appSecret) {
      this.logger.error('Facebook sign-in attempted but FACEBOOK_APP_ID/FACEBOOK_APP_SECRET are not configured');
      throw new UnauthorizedException('Facebook sign-in is not configured on the server');
    }
    const appsecretProof = createHmac('sha256', appSecret).update(token).digest('hex');

    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}` +
        `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
    );
    if (!debugRes.ok) throw new UnauthorizedException('Invalid Facebook token');
    const debugData = (await debugRes.json()) as {
      data?: { is_valid?: boolean; app_id?: string; user_id?: string };
    };
    if (!debugData.data?.is_valid || debugData.data.app_id !== appId) {
      throw new UnauthorizedException('Invalid Facebook token');
    }

    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)` +
        `&access_token=${encodeURIComponent(token)}&appsecret_proof=${appsecretProof}`,
    );
    if (!profileRes.ok) throw new UnauthorizedException('Invalid Facebook token');
    const data = (await profileRes.json()) as {
      id: string;
      name?: string;
      email?: string;
      picture?: { data?: { url?: string; is_silhouette?: boolean } };
      error?: object;
    };
    if (data.error || data.id !== debugData.data.user_id) throw new UnauthorizedException('Invalid Facebook token');
    // is_silhouette means the user has no real profile photo — Facebook's default generic
    // avatar isn't worth saving as if it were one.
    const pictureUrl = data.picture?.data?.is_silhouette ? undefined : data.picture?.data?.url;
    return this.socialProfile(data.id, data.email ?? `${data.id}@facebook.com`, data.name, pictureUrl);
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
    if (!this.emailService.isConfigured) {
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

    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    user.passwordChangedAt = new Date();
    await this.usersRepository.save(user);
    await this.otpRepository.delete({ email: match.email });
    this.logger.log(`Password reset successfully for user: ${match.email}`);
    await this.sendPasswordResetEmail(match.email);
  }

  // Logged-in password change (vs. resetPassword's forgot-password/OTP flow) — requires
  // proving the current password rather than a code, so it uses UnauthorizedException the
  // same way login does for a bad credential.
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash ?? '');
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.passwordChangedAt = new Date();
    await this.usersRepository.save(user);
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
}
