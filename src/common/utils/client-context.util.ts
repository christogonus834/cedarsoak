import * as crypto from 'crypto';

export interface ClientContextData {
  // Coarse network identifier (first three IPv4 octets / first four IPv6
  // groups). Coarse on purpose: mobile carriers rotate addresses within a
  // range constantly, so exact-IP matching would flag ordinary users
  // constantly, while still being specific enough to notice a genuinely
  // different network. Null if the IP could not be determined.
  ipPrefix: string | null;
  // SHA-256 of the client-supplied `x-device-id` header. Hashed so the raw
  // identifier is never stored. Null if the client sent none.
  fingerprintHash: string | null;
}

export function normalizeIpPrefix(rawIp: string | undefined | null): string | null {
  if (!rawIp) return null;
  let ip = rawIp.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6 address

  if (ip.includes('.') && !ip.includes(':')) {
    const octets = ip.split('.');
    if (octets.length !== 4) return null;
    return octets.slice(0, 3).join('.');
  }

  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':');
  }

  return null;
}

export function hashDeviceId(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 200) return null; // too short to be meaningful / abusive length
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

export function extractClientContext(req: {
  ip?: string;
  headers?: Record<string, unknown>;
}): ClientContextData {
  const deviceHeader = req.headers?.['x-device-id'];
  return {
    ipPrefix: normalizeIpPrefix(req.ip),
    fingerprintHash: hashDeviceId(Array.isArray(deviceHeader) ? deviceHeader[0] : (deviceHeader as string | undefined)),
  };
}
