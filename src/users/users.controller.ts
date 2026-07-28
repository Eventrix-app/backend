import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Request,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt.util';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';
import { UpdateNotificationChannelsDto } from './participant/dto/update-notification-channels.dto';
import { UpdatePushTokenDto } from './participant/dto/update-push-token.dto';
import { EraseMyDataDto } from './dto/erase-my-data.dto';
import { UsersService } from './users.service';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@Request() req: Request & { user: JwtPayload }) {
    return await this.usersService.findMe(req.user.id);
  }

  // Declared after 'me' so the literal segment wins the routing match over this param route.
  // @Public() because the Shorts feed is browsable signed out, and tapping a reel's author
  // has to work from there too.
  @Public()
  @Get(':id/public')
  async getPublicProfile(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.findPublicProfile(id);
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

  // Called on logout — see UsersService.clearPushToken for why this matters. Takes the
  // token in the body (not implicit) since push tokens are now multi-device: this must
  // clear only the calling device's registration, not every device this account is
  // signed in on.
  @Delete('me/push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMyPushToken(
    @Body() dto: UpdatePushTokenDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.clearPushToken(req.user.id, dto.pushToken);
  }

  @Patch('me/notification-channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateMyNotificationChannels(
    @Body() dto: UpdateNotificationChannelsDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.updateNotificationChannels(req.user.id, dto);
  }

  // Self-service account deletion (Settings → Delete Account). Works for any role
  // (participant/organizer/admin) — unlike ParticipantController's DELETE /participants/:id,
  // this isn't scoped to accounts carrying the 'user' role.
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMe(@Request() req: Request & { user: JwtPayload }) {
    await this.usersService.deleteMe(req.user.id);
  }

  // Self-service DPDP-Act data erasure (Settings → Delete My Data) — distinct from
  // DELETE /users/me above, which only deactivates the account. Throttled for the same
  // reason as password-change-adjacent endpoints: it's a sensitive, identity-verified
  // action that shouldn't be brute-forceable.
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @Delete('me/data')
  @HttpCode(HttpStatus.NO_CONTENT)
  async eraseMyData(
    @Body() dto: EraseMyDataDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.usersService.eraseMyData(req.user.id, dto);
  }

  // Self-service data export (Settings → Download My Data). Emails a JSON copy to the
  // account's own registered address rather than returning it in the response — nothing
  // for a client to store/display, and it's delivered to an address we've already verified
  // control of. Throttled tighter than this controller's other routes since it triggers an
  // outbound email send per call.
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @Post('me/export')
  @HttpCode(HttpStatus.NO_CONTENT)
  async exportMyData(@Request() req: Request & { user: JwtPayload }) {
    await this.usersService.exportMyData(req.user.id);
  }
}