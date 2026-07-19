import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

// Thin transport wrapper — composing subject/body per notification type stays in the
// calling service (AuthService for OTPs, NotificationService for event/waitlist/refund
// updates), same split as UploadsService (transport) vs. the entities that use it.
//
// Never throws: an email provider hiccup must not fail the business operation underneath
// it (e.g. approving a refund shouldn't 500 just because Resend timed out). Missing config
// is handled the same way CacheService/UploadsService handle a missing Redis/Supabase key —
// every call becomes a logged no-op rather than a crash, so local dev without a Resend key
// still runs the rest of the app.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('email.resendApiKey');
    this.from = configService.get<string>('email.from', 'onboarding@resend.dev');
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  get isConfigured(): boolean {
    return this.resend !== null;
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`Email not sent (RESEND_API_KEY not configured): "${subject}" to ${to}`);
      return;
    }
    try {
      const { error } = await this.resend.emails.send({ from: this.from, to, subject, html });
      if (error) {
        this.logger.error(`Resend rejected email "${subject}" to ${to}: ${error.message}`);
        return;
      }
      this.logger.log(`Email sent: "${subject}" to ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send email "${subject}" to ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
