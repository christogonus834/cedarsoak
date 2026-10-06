import { Injectable, Logger } from '@nestjs/common';
import { BrevoProvider } from './providers/brevo.provider';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private brevo: BrevoProvider) {}

  async sendOtpEmail(to: string, code: string, purpose: string) {
    const purposeLabel = this.purposeLabel(purpose);
    await this.safely(() =>
      this.brevo.sendEmail({
        to: [{ email: to }],
        subject: `Your CedarOaks ${purposeLabel} code`,
        htmlContent: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>CedarOaks</h2>
            <p>Your ${purposeLabel.toLowerCase()} code is:</p>
            <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${code}</p>
            <p>This code expires shortly and can only be used once. If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      }),
    );
  }

  async sendOtpSms(to: string, code: string, purpose: string) {
    const purposeLabel = this.purposeLabel(purpose);
    await this.safely(() =>
      this.brevo.sendSms({
        recipient: to,
        content: `CedarOaks: Your ${purposeLabel.toLowerCase()} code is ${code}. It expires shortly. Do not share this code with anyone.`,
        tag: purpose,
      }),
    );
  }

  async sendWelcomeEmail(to: string, firstName: string) {
    await this.safely(() =>
      this.brevo.sendEmail({
        to: [{ email: to, name: firstName }],
        subject: 'Welcome to CedarOaks',
        htmlContent: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Welcome, ${firstName}!</h2>
            <p>Your CedarOaks account has been created. You can now join a cooperative and start saving.</p>
          </div>
        `,
      }),
    );
  }

  // Ready for the Admin Dashboard module's adaptive-authentication flow: a
  // login from a new device/network/unusual time blocks access and sends
  // this confirmation link before the session is allowed to proceed.
  async sendSecurityConfirmationEmail(to: string, confirmationUrl: string, context: {
    device?: string;
    location?: string;
    time?: string;
  }) {
    await this.safely(() =>
      this.brevo.sendEmail({
        to: [{ email: to }],
        subject: 'Confirm this login to your CedarOaks account',
        htmlContent: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>Unrecognized login attempt</h2>
            <p>We noticed a login attempt that doesn't match your usual activity:</p>
            <ul>
              ${context.device ? `<li>Device: ${context.device}</li>` : ''}
              ${context.location ? `<li>Location: ${context.location}</li>` : ''}
              ${context.time ? `<li>Time: ${context.time}</li>` : ''}
            </ul>
            <p>If this was you, confirm it below to continue:</p>
            <p><a href="${confirmationUrl}" style="display:inline-block;padding:12px 20px;background:#2f5fd6;color:white;text-decoration:none;border-radius:6px;">Confirm login</a></p>
            <p>If this wasn't you, do not click the link — consider changing your password immediately.</p>
          </div>
        `,
      }),
    );
  }

  // A general-purpose alert used across future modules (loan approvals,
  // overdue contribution reminders, admin actions) — kept generic here so
  // each calling module doesn't need its own Brevo integration.
  async sendAlertEmail(to: string, subject: string, message: string) {
    await this.safely(() =>
      this.brevo.sendEmail({
        to: [{ email: to }],
        subject,
        htmlContent: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;"><p>${message}</p></div>`,
      }),
    );
  }

  private purposeLabel(purpose: string): string {
    const labels: Record<string, string> = {
      PASSWORD_RESET: 'Password Reset',
      LOGIN_VERIFICATION: 'Login Verification',
    };
    return labels[purpose] || 'Verification';
  }

  // Notification failures should never crash the calling flow (e.g. a
  // registration shouldn't fail just because the welcome email didn't send).
  // They're logged loudly instead, so they're visible to fix without taking
  // down an otherwise-successful user action.
  private async safely(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error('Notification send failed', err as Error);
    }
  }
}
