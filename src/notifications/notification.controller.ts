import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { JwtPayload } from '../auth/jwt.util';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  async findMine(@Request() req: Request & { user: JwtPayload }) {
    return await this.notificationService.findMyNotifications(req.user.id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@Request() req: Request & { user: JwtPayload }) {
    await this.notificationService.markAllRead(req.user.id);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: Request & { user: JwtPayload },
  ) {
    await this.notificationService.markRead(id, req.user.id);
  }
}
