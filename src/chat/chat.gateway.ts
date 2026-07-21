import { Logger, UnauthorizedException, UsePipes, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtPayload } from '../auth/jwt.util';
import { ChatService } from './chat.service';
import { JoinEventDto } from './dto/join-event.dto';
import { SendChatMessageDto } from './dto/send-chat-message.dto';

// One namespace shared by every event's chat room, rather than a namespace per event —
// socket.io namespaces are meant to be a small, static set (each gets its own middleware/
// adapter machinery); rooms are the intended mechanism for a dynamic, per-resource space,
// and let one connection be a member of several event rooms at once if ever needed.
const room = (eventId: string) => `event:${eventId}`;

type AuthedSocket = Socket & { data: { user?: JwtPayload } };

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const isLocalhost = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (isLocalhost || origin === process.env.FRONTEND_URL) callback(null, true);
      else callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // Auth happens once at handshake, not per-message — REST's JwtAuthGuard runs per-request
  // because HTTP is stateless; a socket connection stays open, so verifying the token here
  // and caching the payload on `client.data.user` is the WS equivalent of that guard.
  async handleConnection(client: AuthedSocket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.headers.authorization?.startsWith('Bearer ')
          ? client.handshake.headers.authorization.slice('Bearer '.length)
          : undefined);
      if (!token) throw new UnauthorizedException('Missing token');

      const secret = this.configService.get<string>('JWT_SECRET');
      if (!secret) throw new UnauthorizedException('Authentication is not configured');

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, { secret });
      client.data.user = payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      this.logger.warn(`Socket auth failed: ${message}`);
      client.emit('authError', { message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthedSocket): void {
    // Rooms are cleaned up automatically by socket.io on disconnect — nothing to do here.
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('joinEvent')
  async handleJoinEvent(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: JoinEventDto) {
    await this.chatService.assertEventExists(body.eventId);
    await client.join(room(body.eventId));
    return { eventId: body.eventId, joined: true };
  }

  @SubscribeMessage('leaveEvent')
  async handleLeaveEvent(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: JoinEventDto) {
    await client.leave(room(body.eventId));
    return { eventId: body.eventId, joined: false };
  }

  // Called by AnnouncementsService after a REST-created announcement is persisted, so
  // anyone currently viewing the event's Community tab sees it appear live — this is what
  // #2's plan means by "folds Announcements into #10's socket room for free".
  broadcastAnnouncement(eventId: string, announcement: unknown): void {
    this.server.to(room(eventId)).emit('announcement', announcement);
  }

  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('sendMessage')
  async handleSendMessage(@ConnectedSocket() client: AuthedSocket, @MessageBody() body: SendChatMessageDto) {
    const user = client.data.user;
    if (!user) {
      client.emit('authError', { message: 'Not authenticated' });
      return;
    }
    const record = await this.chatService.createMessage(body.eventId, user.id, body.message);
    this.server.to(room(body.eventId)).emit('newMessage', record);
    return record;
  }
}
