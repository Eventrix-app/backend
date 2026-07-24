import { Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ChatService } from './chat.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { JwtPayload } from '../auth/jwt.util';

@ApiTags('chat')
@Controller('events/:eventId/chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatRealtimeService: ChatRealtimeService,
  ) {}

  @Get('messages')
  async getMessages(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Request() req: Request & { user?: JwtPayload },
  ) {
    return await this.chatService.getHistory(eventId, req.user?.id, req.user?.roles ?? [], page, limit);
  }

  // Live delivery to other viewers happens via ChatRealtimeService after persisting below —
  // see that file for why this is a plain REST call rather than a socket.
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('messages')
  async sendMessage(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: SendChatMessageDto,
    @Request() req: Request & { user: JwtPayload },
  ) {
    const record = await this.chatService.createMessage(eventId, req.user.id, req.user.roles ?? [], dto.message);
    this.chatRealtimeService.broadcastMessage(eventId, record);
    return record;
  }
}
