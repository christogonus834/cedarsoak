// Centralized config access. Nothing reads process.env directly anywhere else in the app —
// this is the single place environment variables are read, so missing/invalid config fails
// fast at startup instead of surfacing as a mysterious bug deep in a request handler.

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: requireEnv('DATABASE_URL'),
  jwt: {
    accessSecret: requireEnv('JWT_ACCESS_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  monnify: {
    baseUrl: requireEnv('MONNIFY_BASE_URL'),
    apiKey: requireEnv('MONNIFY_API_KEY'),
    secretKey: requireEnv('MONNIFY_SECRET_KEY'),
    contractCode: requireEnv('MONNIFY_CONTRACT_CODE'),
  },
  paystack: {
    baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    secretKey: requireEnv('PAYSTACK_SECRET_KEY'),
  },
  brevo: {
    apiKey: requireEnv('BREVO_API_KEY'),
    senderEmail: requireEnv('BREVO_SENDER_EMAIL'),
    senderName: process.env.BREVO_SENDER_NAME || 'CedarOaks',
    smsSenderId: process.env.BREVO_SMS_SENDER_ID || 'CedarOaks',
    emailSandbox: process.env.BREVO_EMAIL_SANDBOX === 'true',
  },
  notificationsDryRun: process.env.NOTIFICATIONS_DRY_RUN !== 'false', // defaults to true (safe) unless explicitly disabled
  otpExpiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
  // Number of reverse-proxy/load-balancer hops in front of the app. Must be set
  // correctly in production (e.g. 1 behind a single load balancer) or every
  // request appears to come from the proxy's IP, which would make network-based
  // risk checks meaningless. Leave at 0 for local development.
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  risk: {
    enabled: process.env.RISK_ENABLED !== 'false', // on by default; only disable for local convenience
    timezone: process.env.RISK_TIMEZONE || 'Africa/Lagos',
    quietHoursStart: parseInt(process.env.RISK_QUIET_START || '23', 10), // inclusive
    quietHoursEnd: parseInt(process.env.RISK_QUIET_END || '5', 10), // exclusive
    minBaselineEvents: parseInt(process.env.RISK_MIN_BASELINE_EVENTS || '5', 10),
    hourToleranceHours: parseInt(process.env.RISK_HOUR_TOLERANCE || '2', 10),
    burstLimit: parseInt(process.env.RISK_BURST_LIMIT || '10', 10),
    burstWindowMinutes: parseInt(process.env.RISK_BURST_WINDOW_MINUTES || '10', 10),
  },
  defaultVanProvider: process.env.DEFAULT_VAN_PROVIDER || 'MONNIFY',
});

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    // Fail loudly at boot rather than silently misbehaving later (e.g. signing JWTs
    // with `undefined` as a secret, which would be a serious security hole).
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
