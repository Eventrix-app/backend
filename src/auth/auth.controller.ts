import { Controller, Post, Get, Delete, Param, ParseUUIDPipe, Body, Headers, Request } from '@nestjs/common';
import { AuthService, SessionRecord } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from './dto/create-user.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from './jwt.util';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

class SocialLoginDto {
  @IsIn(['google'])
  provider!: 'google';

  @IsString()
  token!: string;

  // See LoginDto.deviceLabel.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceLabel?: string;
}

// Auth endpoints are unauthenticated by nature, making them the prime target for
// scripted credential-stuffing / account-creation abuse — throttled tighter than the
// app-wide default set in AppModule.
@ApiTags('auth')
@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Headers('user-agent') userAgent?: string): Promise<AuthResponseDto> {
    return await this.authService.login(loginDto, userAgent);
  }

  @Public()
  @Post('register')
  async register(
    @Body() createUserDto: CreateUserDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return await this.authService.register(createUserDto, userAgent);
  }

  @Public()
  @Post('social')
  async socialLogin(
    @Body() body: SocialLoginDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.authService.socialLogin(body.provider, body.token, body.deviceLabel, userAgent);
  }

  // Deliberately not @Public(): requires a still-valid Bearer token, which
  // JwtAuthGuard verifies (signature, expiry, not-banned/deleted) before this runs.
  // Called on every app foreground/launch while logged in — see AppStateSync in
  // Frontend/App.tsx — to keep an actively-used session alive on a sliding 2-day window.
  @Post('refresh')
  async refresh(@Request() req: Request & { user: JwtPayload }): Promise<AuthResponseDto> {
    return await this.authService.refresh(req.user.id, req.user.jti);
  }

  @Public()
  @Post('forgot-password')
  async forgotPassword(@Body() body: ForgotPasswordDto): Promise<void> {
    return await this.authService.forgotPassword(body.email);
  }

  @Public()
  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    return await this.authService.resetPassword(body.token, body.password);
  }

  // Deliberately not @Public(): the caller must already hold a valid session (proves
  // account access), then additionally proves knowledge of the current password —
  // unlike reset-password's OTP, which is for someone who's locked out entirely.
  @Post('change-password')
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Request() req: Request & { user: JwtPayload },
  ): Promise<void> {
    return await this.authService.changePassword(req.user.id, body.currentPassword, body.newPassword);
  }

  // Deliberately not @Public(): unlike forgot-password (for someone locked out entirely),
  // email verification is always for the account you're already logged into — no need to
  // accept an arbitrary email in the body, which would also reopen the email-enumeration
  // concern forgot-password's silent no-op exists to avoid.
  @Post('verify-email/send')
  async sendEmailVerificationOtp(@Request() req: Request & { user: JwtPayload }): Promise<void> {
    return await this.authService.sendEmailVerificationOtp(req.user.id);
  }

  @Post('verify-email/confirm')
  async confirmEmailVerification(
    @Body() body: VerifyEmailDto,
    @Request() req: Request & { user: JwtPayload },
  ): Promise<void> {
    return await this.authService.confirmEmailVerification(req.user.id, body.otp);
  }

  // --- Session management (Settings → Active Sessions) ---

  @Get('sessions')
  async listSessions(@Request() req: Request & { user: JwtPayload }): Promise<SessionRecord[]> {
    return await this.authService.listSessions(req.user.id, req.user.jti);
  }

  // Must be declared before 'sessions/:id' below — NestJS matches routes in declaration
  // order, and a ':id' route declared first would swallow the literal "others" segment as
  // if it were an id (same gotcha as EventsController's pending-vs-:id ordering).
  @Delete('sessions/others')
  async revokeOtherSessions(@Request() req: Request & { user: JwtPayload }): Promise<{ revoked: number }> {
    const revoked = await this.authService.revokeOtherSessions(req.user.id, req.user.jti);
    return { revoked };
  }

  @Delete('sessions/:id')
  async revokeSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ): Promise<void> {
    await this.authService.revokeSession(req.user.id, id);
  }
}
