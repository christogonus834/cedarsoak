import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

// Verified against Paystack's live documentation (paystack.com/docs/api,
// paystack.com/docs/transfers) as of this build:
//   - POST /transferrecipient           -> create/reuse a payout beneficiary
//   - GET  /bank/resolve                -> confirm an account number + name match, before sending money
//   - POST /transfer                    -> initiate a payout from balance
//   - GET  /transfer/verify/:reference  -> independent re-verification (never trust the initiate response alone)
//   - webhook signature: HMAC-SHA512 of the raw body, keyed with the secret key, header `x-paystack-signature`
// Cross-check against paystack.com/docs before going live if any of this has changed.
@Injectable()
export class PaystackProvider {
  private readonly logger = new Logger(PaystackProvider.name);

  constructor(private configService: ConfigService) {}

  private get baseUrl() {
    return this.configService.get<string>('paystack.baseUrl');
  }

  private get secretKey() {
    return this.configService.get<string>('paystack.secretKey') as string;
  }

  private authHeaders() {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  // List of Nigerian banks with their Paystack bank codes — used to populate
  // the "Choose your bank" dropdown on the withdrawal screen, matching the
  // Bank.jpg / Bank_picked.jpg screens from the Figma design.
  async listBanks(): Promise<Array<{ name: string; code: string }>> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/bank?country=nigeria&currency=NGN`,
      { headers: this.authHeaders() },
    );
    const data = await this.parseAndValidate(response, ['data']);
    return data.data.map((bank: any) => ({ name: bank.name, code: bank.code }));
  }

  // Confirms the destination account number actually belongs to a real
  // account and returns the account's registered name — used to show the
  // member "confirm this is the right account" before they submit a
  // withdrawal, and to catch typos before money is ever sent.
  async resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { headers: this.authHeaders() },
    );

    if (!response.ok) {
      // A resolve failure almost always means an invalid account number/bank
      // combination — surface this as a client error, not a generic 500.
      throw new BadRequestException('Could not verify this bank account. Please check the details and try again.');
    }

    const data = await this.parseAndValidate(response, ['data.account_name']);
    return { accountName: data.data.account_name };
  }

  // Paystack deduplicates by account number server-side ("a duplicate account
  // number will lead to the retrieval of the existing record"), so it's safe
  // to call this on every withdrawal without maintaining our own recipient
  // cache table.
  async createRecipient(params: {
    accountNumber: string;
    bankCode: string;
    accountName: string;
  }): Promise<{ recipientCode: string }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/transferrecipient`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        type: 'nuban',
        name: params.accountName,
        account_number: params.accountNumber,
        bank_code: params.bankCode,
        currency: 'NGN',
      }),
    });

    const data = await this.parseAndValidate(response, ['data.recipient_code']);
    return { recipientCode: data.data.recipient_code };
  }

  // Initiates the actual payout. Amount is in kobo (Naira * 100) — the caller
  // is responsible for that conversion so this method's contract is explicit.
  // `reference` must be unique per attempt and is what both prevents double
  // payouts on retry AND lets us look this transfer back up later.
  async initiateTransfer(params: {
    amountKobo: number;
    recipientCode: string;
    reference: string;
    reason?: string;
  }): Promise<{ status: string; transferCode: string; paystackReference: string }> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/transfer`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        source: 'balance',
        amount: params.amountKobo,
        recipient: params.recipientCode,
        reference: params.reference,
        reason: params.reason || 'CedarOaks wallet withdrawal',
      }),
    });

    const data = await this.parseAndValidate(response, ['data.status', 'data.transfer_code']);

    // data.status here is Paystack's IMMEDIATE response — "pending" (normal;
    // resolved later via webhook), "success" (sandbox always returns this
    // immediately, per Paystack's docs — "test transfers always return
    // success, because there is no processing involved"), or "otp" (the
    // Paystack account has manual transfer confirmation enabled — this
    // breaks full automation and should be disabled in the Paystack
    // dashboard: Settings > Preferences > uncheck "Confirm transfers before
    // sending"). We never treat this immediate response as final truth on
    // its own — WithdrawalService still waits for the webhook + independent
    // verify() call before marking anything SUCCESSFUL.
    if (data.data.status === 'otp') {
      this.logger.error(
        'Paystack transfer requires OTP confirmation — this account is not configured for ' +
          'automated transfers. Disable OTP in Paystack Dashboard > Settings > Preferences.',
      );
    }

    return {
      status: data.data.status,
      transferCode: data.data.transfer_code,
      paystackReference: data.data.reference,
    };
  }

  // The independent re-verification step — called from the webhook handler,
  // never trusting the webhook payload's claimed status alone.
  async verifyTransfer(reference: string): Promise<{ status: string; amountKobo: number }> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/transfer/verify/${encodeURIComponent(reference)}`,
      { headers: this.authHeaders() },
    );

    const data = await this.parseAndValidate(response, ['data.status', 'data.amount']);
    return { status: data.data.status, amountKobo: data.data.amount };
  }

  // HMAC-SHA512 of the raw body, keyed with the secret key — confirmed
  // against Paystack's official webhook documentation.
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;

    const computed = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');

    const a = Buffer.from(computed);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
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

  private async parseAndValidate(response: Response, requiredPaths: string[]) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Paystack API error (${response.status}): ${text}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('Paystack API returned a non-JSON response.');
    }

    for (const path of requiredPaths) {
      const value = path.split('.').reduce((obj, key) => obj?.[key], data);
      if (value === undefined || value === null) {
        throw new Error(`Paystack API response missing expected field: ${path}`);
      }
    }

    return data;
  }
}
