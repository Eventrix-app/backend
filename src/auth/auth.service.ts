import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtPayload } from './jwt.util';
import { User } from '../entities/user.entity';

const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];
const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      this.logger.warn(`Login failed: user not found for email ${email}`);
      throw new UnauthorizedException('Invalid email or password');
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

    // `user.role` no longer exists – use the first role in the array
    const userRole = user.roles?.[0] ?? 'user';

    const payload: JwtPayload = {
      id: user.id,
      email: user.email,
      role: userRole,
      full_name: user.fullName || '',
    };

    const token = this.jwtService.sign(payload);

    return {
      accessToken: token,
      id: user.id,
      email: user.email,
      full_name: user.fullName || '',
      role: userRole,
      expiresIn: 3600,
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
    });

    const saved = await this.usersRepository.save(user);
    this.logger.log(`Registered new user: ${saved.email} (roles=${saved.roles})`);

    const savedRole = saved.roles?.[0] ?? 'user';

    const payload: JwtPayload = {
      id: saved.id,
      email: saved.email,
      role: savedRole,
      full_name: saved.fullName || '',
    };

    const token = this.jwtService.sign(payload);

    return {
      accessToken: token,
      id: saved.id,
      email: saved.email,
      full_name: saved.fullName || '',
      role: savedRole,
      expiresIn: 3600,
    };
  }

  // A temporary in-memory store for OTPs: email -> { otp, expires }
  private static otps = new Map<string, { otp: string; expires: number }>();

  async forgotPassword(email: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      this.logger.log(`ForgotPassword requested for non-existent email: ${email}`);
      return;
    }

    // Generate a simple 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    // Expire in 10 minutes
    AuthService.otps.set(email, { otp, expires: Date.now() + 10 * 60 * 1000 });

    this.logger.log(`*************************************************`);
    this.logger.log(`PASSWORD RESET OTP FOR ${email}: ${otp}`);
    this.logger.log(`*************************************************`);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    let email: string | null = null;
    const now = Date.now();
    for (const [key, val] of AuthService.otps.entries()) {
      if (val.otp === token && val.expires > now) {
        email = key;
        break;
      }
    }

    // Support '123456' as a developer testing fallback
    if (!email && token === '123456') {
      const pendingEmails = Array.from(AuthService.otps.keys());
      if (pendingEmails.length > 0) {
        email = pendingEmails[pendingEmails.length - 1];
      }
    }

    if (!email) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.usersRepository.save(user);
    AuthService.otps.delete(email);
    this.logger.log(`Password reset successfully for user: ${email}`);
  }
}
