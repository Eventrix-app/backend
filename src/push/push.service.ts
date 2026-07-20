import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

// Thin transport wrapper, same shape as EmailService: composing title/body per
// notification type stays in NotificationService, this only knows how to hand one
// message to Expo's push API. No API key is required for basic sends (accessToken is
// optional, only needed for enhanced push-security/rate limits), so unlike EmailService
// there's no "unconfigured" no-op mode — it always attempts the send and just logs on
// failure, which per-call try/catch in NotificationService already treats as non-fatal.
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly expo: Expo;

  constructor(configService: ConfigService) {
    this.expo = new Expo({ accessToken: configService.get<string>('push.expoAccessToken') });
  }

  async send(
    pushToken: string | null | undefined,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!pushToken) return;
    if (!Expo.isExpoPushToken(pushToken)) {
      this.logger.warn(`Skipping push — not a valid Expo push token: ${pushToken}`);
      return;
    }

    const message: ExpoPushMessage = { to: pushToken, sound: 'default', title, body, data };
    try {
      const [ticket] = await this.expo.sendPushNotificationsAsync([message]);
      if (ticket.status === 'error') {
        this.logger.error(`Expo push rejected for token ${pushToken}: ${ticket.message}`);
        return;
      }
      this.logger.log(`Push sent: "${title}"`);
    } catch (err) {
      this.logger.error(`Failed to send push "${title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
