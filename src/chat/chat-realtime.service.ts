import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Live-delivery layer only — every write still goes through ChatService.createMessage /
// AnnouncementsService.create first (auth, validation, moderation, persistence). This just
// fans the already-persisted record out to whoever has the event's Community tab open.
//
// This replaces the old ChatGateway (a self-hosted socket.io server). That worked locally but
// was fundamentally broken once deployed: Vercel Serverless Functions invoke create-app.ts's
// handler per-HTTP-request and never call app.listen(), so there was never a real long-lived
// process to hold a WebSocket `Upgrade` connection open — every client sat on "connecting"
// forever. Supabase Realtime's Broadcast REST endpoint sidesteps that entirely: this service
// makes a single outbound HTTP POST per message (fine from a stateless Lambda invocation),
// and clients hold their persistent connection to Supabase's own always-on Realtime server
// instead of to this backend.
//
// Uses the documented "broadcast over HTTP" endpoint directly via fetch, rather than
// supabase-js's channel().send() — that path expects a subscribed (i.e. open, held-open)
// socket, which is exactly what a serverless function can't provide either.
@Injectable()
export class ChatRealtimeService {
  private readonly logger = new Logger(ChatRealtimeService.name);

  constructor(private readonly configService: ConfigService) {}

  private async broadcast(eventId: string, event: string, payload: unknown): Promise<void> {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const serviceRoleKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceRoleKey) {
      // Same "optional integration, degrade gracefully" pattern as EmailService/UploadsService/
      // PushService: the message is already persisted, it just won't appear live — clients
      // still see it on their next history refetch.
      this.logger.warn('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured — skipping live broadcast');
      return;
    }

    try {
      const res = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ topic: `event:${eventId}`, event, payload, private: false }],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Realtime broadcast failed for event ${eventId}: HTTP ${res.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Realtime broadcast failed for event ${eventId}: ${message}`);
    }
  }

  broadcastMessage(eventId: string, message: unknown): void {
    void this.broadcast(eventId, 'newMessage', message);
  }

  broadcastAnnouncement(eventId: string, announcement: unknown): void {
    void this.broadcast(eventId, 'announcement', announcement);
  }
}
