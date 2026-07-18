import { Controller, Post, Body, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from './dto/create-user.dto';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from './jwt.util';

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
  async login(@Body() loginDto: LoginDto): Promise<AuthResponseDto> {
    return await this.authService.login(loginDto);
  }

  @Public()
  @Post('register')
  async register(@Body() createUserDto: CreateUserDto): Promise<AuthResponseDto> {
    return await this.authService.register(createUserDto);
  }

  // Deliberately not @Public(): requires a still-valid Bearer token, which
  // JwtAuthGuard verifies (signature, expiry, not-banned/deleted) before this runs.
  // Called on every app foreground/launch while logged in — see AppStateSync in
  // Frontend/App.tsx — to keep an actively-used session alive on a sliding 2-day window.
  @Post('refresh')
  async refresh(@Request() req: Request & { user: JwtPayload }): Promise<AuthResponseDto> {
    return await this.authService.refresh(req.user.id);
  }

  @Public()
  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }): Promise<void> {
    return await this.authService.forgotPassword(body.email);
  }

  @Public()
  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; password: string }): Promise<void> {
    return await this.authService.resetPassword(body.token, body.password);
  }
}
