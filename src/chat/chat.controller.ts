import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service';

// REST fallback for chat history only — sending a message always goes through the
// ChatGateway socket (see chat.gateway.ts). This exists so the Community tab isn't empty
// on first render, before the socket connection finishes handshaking.
@ApiTags('chat')
@Controller('events/:eventId/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('messages')
  async getMessages(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return await this.chatService.getHistory(eventId, page, limit);
  }
}
