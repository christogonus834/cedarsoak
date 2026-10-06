import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Verified against Brevo's live API documentation (developers.brevo.com) as of
// this build:
//   - Email: POST https://api.brevo.com/v3/smtp/email
//   - SMS:   POST https://api.brevo.com/v3/transactionalSMS/send
//            (the older /v3/transactionalSMS/sms endpoint still works but is
//            deprecated in Brevo's own changelog — using the current one)
//   - Auth: `api-key` header (not Bearer) on every request, for both APIs.
//   - Email sandbox testing: NOT an HTTP header — it's a `headers` object
//     INSIDE the JSON body: { "headers": { "X-Sib-Sandbox": "drop" } }. Easy
//     to get wrong by treating it as a real HTTP header.
// Cross-check against developers.brevo.com if anything here seems to have shifted.
@Injectable()
export class BrevoProvider {
  private readonly logger = new Logger(BrevoProvider.name);
  private readonly baseUrl = 'https://api.brevo.com/v3';

  constructor(private configService: ConfigService) {}

  private get apiKey() {
    return this.configService.get<string>('brevo.apiKey') as string;
  }

  async sendEmail(params: {
    to: { email: string; name?: string }[];
    subject: string;
    htmlContent: string;
  }): Promise<{ messageId: string }> {
    const dryRun = this.configService.get<boolean>('notificationsDryRun');
    if (dryRun) {
      this.logger.log(`[DRY RUN] Email to ${params.to.map((t) => t.email).join(', ')}: "${params.subject}"`);
      return { messageId: 'dry-run' };
    }

    const sandbox = this.configService.get<boolean>('brevo.emailSandbox');
    const body: Record<string, unknown> = {
      sender: {
        email: this.configService.get<string>('brevo.senderEmail'),
        name: this.configService.get<string>('brevo.senderName'),
      },
      to: params.to,
      subject: params.subject,
      htmlContent: params.htmlContent,
    };

    // IMPORTANT: this is a field INSIDE the JSON body, not an HTTP header —
    // easy to get wrong, and getting it wrong means real emails get sent
    // during what you thought was a safe sandbox test.
    if (sandbox) {
      body.headers = { 'X-Sib-Sandbox': 'drop' };
    }

    const response = await this.fetchWithTimeout(`${this.baseUrl}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await this.parseAndValidate(response, []);
    return { messageId: data.messageId ?? 'unknown' };
  }

  async sendSms(params: { recipient: string; content: string; tag?: string }): Promise<{ messageId: number }> {
    const dryRun = this.configService.get<boolean>('notificationsDryRun');
    if (dryRun) {
      this.logger.log(`[DRY RUN] SMS to ${params.recipient}: "${params.content}"`);
      return { messageId: 0 };
    }

    // Brevo's own examples send the recipient without a leading "+" — strip
    // it defensively so a caller passing either format ("+234..." or "234...")
    // works consistently.
    const recipient = params.recipient.replace(/^\+/, '');

    const response = await this.fetchWithTimeout(`${this.baseUrl}/transactionalSMS/send`, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: this.configService.get<string>('brevo.smsSenderId'),
        recipient,
        content: params.content,
        type: 'transactional', // NEVER 'marketing' for OTP/alerts — and never include a stop/opt-out code in content, or Brevo silently reclassifies it as marketing
        tag: params.tag,
      }),
    });

    const data = await this.parseAndValidate(response, ['messageId']);
    return { messageId: data.messageId };
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Same "never trust the external response shape blindly" pattern used for
  // Monnify and Paystack — validate before reading fields off it.
  private async parseAndValidate(response: Response, requiredPaths: string[]) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Brevo API error (${response.status}): ${text}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      // Brevo's email endpoint returns a 201 with a small JSON body; some
      // successful calls may return no body at all depending on the exact
      // scenario — treat an unparsable-but-ok response as a soft success
      // rather than throwing, since response.ok already confirmed success.
      return {};
    }

    for (const path of requiredPaths) {
      if (data[path] === undefined || data[path] === null) {
        throw new Error(`Brevo API response missing expected field: ${path}`);
      }
    }

    return data;
  }
}
