import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';

// Thin transport wrapper — composing subject/body per notification type stays in the
// calling service (AuthService for OTPs, NotificationService for event/waitlist/refund
// updates), same split as UploadsService (transport) vs. the entities that use it.
//
// Never throws: an email provider hiccup must not fail the business operation underneath
// it (e.g. approving a refund shouldn't 500 just because Resend timed out). Missing config
// is handled the same way CacheService/UploadsService handle a missing Redis/Supabase key —
// every call becomes a logged no-op rather than a crash, so local dev without a Resend key
// still runs the rest of the app.
//
// Resend stays primary; a SMTP transport (via Nodemailer) is a fallback only — used when
// Resend isn't configured, or when a Resend send fails, so one provider outage doesn't
// silently drop transactional email (OTPs, refund/waitlist notifications) entirely.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;
  private readonly resendFrom: string;
  private readonly smtpTransport: nodemailer.Transporter | null;
  private readonly smtpFrom: string;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('email.resendApiKey');
    this.resendFrom = configService.get<string>('email.from', 'onboarding@resend.dev');
    this.resend = apiKey ? new Resend(apiKey) : null;

    const smtpHost = configService.get<string>('email.smtp.host');
    const smtpUser = configService.get<string>('email.smtp.user');
    const smtpPass = configService.get<string>('email.smtp.pass');
    this.smtpFrom = configService.get<string>('email.smtp.from', this.resendFrom);
    this.smtpTransport =
      smtpHost && smtpUser && smtpPass
        ? nodemailer.createTransport({
            host: smtpHost,
            port: configService.get<number>('email.smtp.port', 587),
            secure: configService.get<boolean>('email.smtp.secure', false),
            auth: { user: smtpUser, pass: smtpPass },
          })
        : null;
  }

  get isConfigured(): boolean {
    return this.resend !== null || this.smtpTransport !== null;
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    if (this.resend) {
      const sentViaResend = await this.sendViaResend(to, subject, html);
      if (sentViaResend) return;
      // Resend is configured but failed (rejected send or threw) — fall through to SMTP
      // if available, rather than treating this delivery as done.
    }

    if (this.smtpTransport) {
      await this.sendViaSmtp(to, subject, html);
      return;
    }

    if (!this.resend) {
      this.logger.warn(`Email not sent (no provider configured): "${subject}" to ${to}`);
    }
  }

  private async sendViaResend(to: string, subject: string, html: string): Promise<boolean> {
    try {
      const { error } = await this.resend!.emails.send({ from: this.resendFrom, to, subject, html });
      if (error) {
        this.logger.error(`Resend rejected email "${subject}" to ${to}: ${error.message}`);
        return false;
      }
      this.logger.log(`Email sent via Resend: "${subject}" to ${to}`);
      return true;
    } catch (err) {
      this.logger.error(`Resend threw for email "${subject}" to ${to}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async sendViaSmtp(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.smtpTransport!.sendMail({ from: this.smtpFrom, to, subject, html });
      this.logger.log(`Email sent via SMTP fallback: "${subject}" to ${to}`);
    } catch (err) {
      this.logger.error(`SMTP fallback failed for email "${subject}" to ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
