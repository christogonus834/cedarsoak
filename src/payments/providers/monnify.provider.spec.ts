import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { MonnifyProvider } from './monnify.provider';

// This is the single most important test in the payments module: if signature
// verification is broken (too permissive), anyone on the internet can forge a
// webhook and credit any wallet by guessing an account reference. If it's
// broken the other way (too strict), real payments silently fail to credit.
describe('MonnifyProvider.verifyWebhookSignature', () => {
  let provider: MonnifyProvider;
  const secretKey = 'test-secret-key';

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MonnifyProvider,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'monnify.secretKey' ? secretKey : 'irrelevant') },
        },
      ],
    }).compile();

    provider = moduleRef.get(MonnifyProvider);
  });

  it('accepts a signature correctly computed over the exact raw body', () => {
    const rawBody = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION' }));
    const validSignature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');

    expect(provider.verifyWebhookSignature(rawBody, validSignature)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret (forged webhook)', () => {
    const rawBody = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION' }));
    const forgedSignature = crypto
      .createHmac('sha512', 'wrong-secret')
      .update(rawBody)
      .digest('hex');

    expect(provider.verifyWebhookSignature(rawBody, forgedSignature)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing (e.g. amount changed)', () => {
    const originalBody = Buffer.from(JSON.stringify({ amount: 5000 }));
    const signatureForOriginal = crypto
      .createHmac('sha512', secretKey)
      .update(originalBody)
      .digest('hex');

    const tamperedBody = Buffer.from(JSON.stringify({ amount: 500000 }));

    expect(provider.verifyWebhookSignature(tamperedBody, signatureForOriginal)).toBe(false);
  });

  it('rejects when no signature header is present at all', () => {
    const rawBody = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION' }));
    expect(provider.verifyWebhookSignature(rawBody, undefined)).toBe(false);
  });
});
