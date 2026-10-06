import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  GeneratedVirtualAccount,
  VanProviderAdapter,
  VerifiedTransaction,
} from '../interfaces/van-provider.interface';

// IMPORTANT: Monnify's exact endpoint paths, field names, and signature scheme
// occasionally change between API versions. This is written against Monnify's
// documented v2/v3 Reserved Accounts + Transaction Verification APIs as of
// this build — cross-check against https://developers.monnify.com before
// going live, and update this file if anything has shifted.
@Injectable()
export class MonnifyProvider implements VanProviderAdapter {
  readonly providerName = 'MONNIFY';
  private readonly logger = new Logger(MonnifyProvider.name);
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private configService: ConfigService) {}

  private get baseUrl() {
    return this.configService.get<string>('monnify.baseUrl');
  }

  // Monnify uses OAuth-style Basic Auth to get a short-lived bearer token,
  // which is then used on every subsequent API call. Cached until near expiry
  // so we're not re-authenticating on every request.
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const apiKey = this.configService.get<string>('monnify.apiKey');
    const secretKey = this.configService.get<string>('monnify.secretKey');
    const credentials = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}` },
    });

    const data = await this.parseAndValidate(response, ['responseBody.accessToken']);

    this.accessToken = data.responseBody.accessToken;
    // Refresh a minute before actual expiry as a safety margin.
    this.tokenExpiresAt = Date.now() + (data.responseBody.expiresIn - 60) * 1000;
    return this.accessToken as string;
  }

  // CORRECTED against live docs (developers.monnify.com/docs/collections/recurring-payments/reserved-accounts):
  // BVN (or NIN) is a MANDATORY field on this request — Monnify rejects the
  // call without it. This is why our onboarding flow requires BVN verification
  // (see the BVN step in the app) before a wallet's virtual account can be
  // provisioned; WalletService.provisionVirtualAccount() enforces this by
  // checking user.bvnVerified before calling this method.
  async generateVirtualAccount(params: {
    accountReference: string;
    accountName: string;
    customerEmail: string;
    customerPhone: string;
    bvn: string;
  }): Promise<GeneratedVirtualAccount> {
    const token = await this.getAccessToken();
    const contractCode = this.configService.get<string>('monnify.contractCode');

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountReference: params.accountReference,
          accountName: params.accountName,
          currencyCode: 'NGN',
          contractCode,
          customerEmail: params.customerEmail,
          customerName: params.accountName,
          bvn: params.bvn,
          getAllAvailableBanks: false,
          // Restrict to specific bank(s) if desired — leaving Monnify to assign
          // its default partner bank if not specified.
        }),
      },
    );

    // CORRECTED: the actual response nests bank details inside an `accounts`
    // ARRAY (to support multi-bank reserved accounts via getAllAvailableBanks),
    // not flat top-level `accountNumber`/`bankName` fields as an older,
    // deprecated API version returned. Confirmed against the current docs
    // sample response, which shows:
    //   "accounts": [ { "bankCode", "bankName", "accountNumber", "accountName" } ]
    const data = await this.parseAndValidate(response, ['responseBody.accounts']);
    const accounts = data.responseBody.accounts;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('Monnify response contained no bank accounts.');
    }

    const primaryAccount = accounts[0];

    return {
      provider: this.providerName,
      accountNumber: primaryAccount.accountNumber,
      bankName: primaryAccount.bankName,
      accountReference: params.accountReference,
    };
  }

  // CONFIRMED endpoint: GET {baseUrl}/api/v2/transactions/{transactionReference}
  // (URL-encoded). Monnify's real paymentStatus values include: PAID,
  // OVERPAID, PARTIALLY_PAID, PENDING, ABANDONED, CANCELLED, FAILED, REVERSED,
  // EXPIRED. We only treat PAID as fundable — OVERPAID/PARTIALLY_PAID mainly
  // apply to fixed-amount checkout flows (where a contract can be configured
  // to accept them), not open-ended reserved-account funding, where any
  // amount transferred in is legitimate and simply credited as-is. Anything
  // other than PAID here is deliberately NOT credited; the webhook controller
  // logs and skips these rather than guessing at partial credit logic.
  async verifyTransaction(providerReference: string): Promise<VerifiedTransaction> {
    const token = await this.getAccessToken();

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v2/transactions/${encodeURIComponent(providerReference)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const data = await this.parseAndValidate(response, ['responseBody']);
    const body = data.responseBody;

    return {
      isSuccessful: body.paymentStatus === 'PAID',
      amount: String(body.amountPaid ?? body.amount ?? '0'),
      providerReference: body.transactionReference,
      accountReference: body.product?.reference ?? body.accountReference,
      raw: body,
    };
  }

  // Monnify signs webhook payloads: SHA512 HMAC of the raw request body using
  // the Client Secret Key, sent in the `monnify-signature` header. This MUST
  // be computed over the raw, untouched request bytes — computing it over a
  // JSON.stringify() of the parsed body will produce a different signature if
  // key ordering or whitespace differs from what Monnify originally sent.
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;

    const secretKey = this.configService.get<string>('monnify.secretKey') as string;
    const computedSignature = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');

    // Constant-time comparison — prevents a timing attack from being used to
    // guess the correct signature byte-by-byte.
    const a = Buffer.from(computedSignature);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch (err) {
      this.logger.error('Monnify health check failed', err as Error);
      return false;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Native fetch (Node 18+) — no extra HTTP client dependency needed.
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Validates the response is well-formed JSON with the expected shape before
  // any calling code reads a field off it — per our "never trust external
  // response shape" rule. A malformed or unexpected response throws here
  // rather than causing a confusing crash three lines later.
  private async parseAndValidate(response: Response, requiredPaths: string[]) {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Monnify API error (${response.status}): ${text}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('Monnify API returned a non-JSON response.');
    }

    for (const path of requiredPaths) {
      const value = path.split('.').reduce((obj, key) => obj?.[key], data);
      if (value === undefined || value === null) {
        throw new Error(`Monnify API response missing expected field: ${path}`);
      }
    }

    return data;
  }
}
