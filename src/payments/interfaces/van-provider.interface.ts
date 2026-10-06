// Every virtual-account provider (Monnify now, two backups later) implements
// this interface. Business logic (WalletService, the webhook controller)
// depends only on this interface — never on a specific provider's SDK/shape.
// This is what makes adding/removing/failing-over providers a matter of
// writing one new class, not touching everything downstream.

export interface GeneratedVirtualAccount {
  provider: string; // "MONNIFY" | "BACKUP_PROVIDER_A" | "BACKUP_PROVIDER_B"
  accountNumber: string;
  bankName: string;
  accountReference: string; // our own reference sent to the provider, used to map webhooks back to a wallet
}

export interface VerifiedTransaction {
  isSuccessful: boolean;
  amount: string; // decimal as string
  providerReference: string; // the provider's own transaction ID
  accountReference: string; // maps back to the wallet that was funded
  raw: unknown; // full provider response, stored in metadata for audit purposes
}

export interface VanProviderAdapter {
  readonly providerName: string;

  generateVirtualAccount(params: {
    accountReference: string; // our reference, unique per wallet
    accountName: string;
    customerEmail: string;
    customerPhone: string;
    bvn: string; // CONFIRMED mandatory by Monnify — enforce bvnVerified upstream before calling this
  }): Promise<GeneratedVirtualAccount>;

  // Called by the webhook handler AFTER signature verification, to
  // independently confirm the transaction actually happened — per our
  // "never trust external responses blindly" rule, the webhook payload alone
  // is never sufficient grounds to credit a wallet.
  verifyTransaction(providerReference: string): Promise<VerifiedTransaction>;

  // Verifies the webhook's HMAC signature against the RAW request body.
  // Must be called with the raw, unparsed bytes — not a re-serialized JSON
  // object, which can produce a different byte sequence and silently fail
  // (or worse, silently "pass" if implemented incorrectly).
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;

  // Lightweight check used by the health-check job to decide on auto-failover.
  checkHealth(): Promise<boolean>;
}
