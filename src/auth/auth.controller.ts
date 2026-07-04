import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { Public } from '../common/decorators/public.decorator';
import { ApiTags } from '@nestjs/swagger';
import { AdminService } from '../users/admin/admin.service';
import { CreateAdminDto } from '../users/admin/dto/create-admin.dto';
import { ParticipantService } from '../users/participant/participant.service';
import { CreateParticipantDto } from '../users/participant/dto/create-participant.dto';
import { OrganizerService } from '../users/organizer/organizer.service';
import { CreateOrganizerDto } from '../users/organizer/dto/create-organizer.dto';

import { CreateUserDto } from './dto/create-user.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminService: AdminService,
    private readonly participantService: ParticipantService,
    private readonly organizerService: OrganizerService,
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
