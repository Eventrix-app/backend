import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Put,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtPayload } from '../auth/jwt.util';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';
import { UpdateNotificationChannelsDto } from './participant/dto/update-notification-channels.dto';
import { UpdatePushTokenDto } from './participant/dto/update-push-token.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Request() req: Request & { user: JwtPayload }) {
    return await this.usersService.findMe(req.user.id);
  }

  @Put('me/interests')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyInterests(
    @Body() dto: UpdateInterestsDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updateInterests(req.user.id, dto);
  }

  @Patch('me/location')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyLocation(
    @Body() dto: UpdateLocationDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updateLocation(req.user.id, dto);
  }

  @Patch('me/notification-preferences')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyNotificationPrefs(
    @Body() dto: UpdateNotificationPrefsDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updateNotificationPrefs(req.user.id, dto);
  }

  @Patch('me/complete-onboarding')
  @HttpCode(HttpStatus.NO_CONTENT)
  async completeMyOnboarding(@Request() req: Request & { user: JwtPayload }) {
    await this.usersService.completeOnboarding(req.user.id);
  }

  @Patch('me/push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyPushToken(
    @Body() dto: UpdatePushTokenDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updatePushToken(req.user.id, dto.pushToken);
  }

  // Called on logout — see UsersService.clearPushToken for why this matters.
  @Delete('me/push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMyPushToken(@Request() req: Request & { user: JwtPayload }) {
    await this.usersService.clearPushToken(req.user.id);
  }

  @Patch('me/notification-channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyNotificationChannels(
    @Body() dto: UpdateNotificationChannelsDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updateNotificationChannels(req.user.id, dto);
  }
}