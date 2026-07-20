import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtPayload, SESSION_TOKEN_TTL_SECONDS } from './jwt.util';
import { User } from '../entities/user.entity';
import { PasswordResetOtp } from '../entities/password-reset-otp.entity';
import { EmailService } from '../email/email.service';

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];
const BCRYPT_ROUNDS = 10;
const OTP_TTL_MINUTES = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(PasswordResetOtp)
    private readonly otpRepository: Repository<PasswordResetOtp>,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
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
      // Legacy rows from the previous (unhashed) AuthService: compare plaintext and re-hash on success
      passwordMatches = stored === password;
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
      // Reaching /auth/register in the app's current flow already means the user went
      // through the full pre-auth onboarding chain (carousel + interests + location +
      // notification prefs) — see user.entity.ts.
      hasCompletedOnboarding: true,
    });

    const saved = await this.usersRepository.save(user);
    this.logger.log(`Registered new user: ${saved.email} (roles=${saved.roles})`);

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
    };
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

    await this.emailService.send(
      email,
      'Your Eventrix password reset code',
      `<p>Your password reset code is:</p>` +
        `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${otp}</p>` +
        `<p>This code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>`,
    );

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
    // drive the reset flow without tailing server logs. Gated out of production: unlike
    // the rest of this flow, this specific branch previously had no environment check at
    // all, making it a live account-takeover backdoor rather than a dev convenience.
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    if (!match && token === '123456' && !isProduction) {
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
    await this.usersRepository.save(user);
    await this.otpRepository.delete({ email: match.email });
    this.logger.log(`Password reset successfully for user: ${match.email}`);
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
    await this.usersRepository.save(user);
    this.logger.log(`Password changed for user: ${user.email}`);
  }
}
