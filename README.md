# CedarOaks Backend — Foundation, Wallet Ledger, Monnify Funding, Paystack Withdrawals, Contribution Payments, Swagger Docs, Notifications, Admin Dashboard, Loans & Adaptive Authentication

**→ For a full step-by-step guide to running this app and testing every
endpoint with Postman (or curl, or any other HTTP client), see
[`TESTING.md`](./TESTING.md).** It also includes a ready-to-import Postman
collection in the `postman/` folder.

**→ Live, interactive API docs are served at `/api/docs` once the app is
running** (e.g. `http://localhost:3000/api/docs`) — this is what to hand your
mobile/frontend developers. The raw OpenAPI spec (importable into any other
tool) is at `/api/docs-json`.

## What's new in this build: Adaptive Authentication

Every login is scored against four signals, compared to the account's own
history rather than a fixed rule: an unrecognised device, a network never
seen before on a successful login, a login hour outside what's normal for
this account (or, before any history exists, the configured late-night
window for privileged accounts), and a "someone reused an already-rotated
refresh token" signal.

- **Admin and staff: any ONE signal blocks login outright.** No read-only or
  temporary access is granted — `POST /auth/login` returns
  `{ challengeRequired: true, challengeId }` instead of tokens, and a 6-digit
  code is sent to the account's email **and phone**.
- **Members: two or more signals** are required to block login, and the code
  goes to email only — a deliberately lighter bar, so an ordinary new-phone-
  or-travelling member isn't locked out for normal behaviour.
- **`POST /auth/login/confirm`** — submit `{ challengeId, code }` to complete
  the blocked login. Success issues a token pair and marks the device
  trusted going forward.
- **Refresh token reuse is now actively detected**, not just rejected: if a
  refresh token that was already rotated is presented again, every active
  session for that account is revoked immediately, the event is written to
  `AuditLog`, and the account is forced through the challenge flow on its
  next login — regardless of role.
- **`x-device-id` header** (optional, any HTTP call): a stable client-
  generated identifier, hashed before storage and used only as a risk
  signal — never trusted as identity on its own. Send the same value
  consistently from a given device/app install.
- **Burst limiting on sensitive admin actions**: payment reversal, loan
  approve/reject/disburse, role assignment, and VAN provider switching are
  all guarded by `BurstLimitGuard` — more than `RISK_BURST_LIMIT` such
  actions within `RISK_BURST_WINDOW_MINUTES` temporarily restricts the
  account with a 429, since a sudden burst of sensitive actions is exactly
  what a compromised admin session would look like.

**Honest limitation**: the device id is client-supplied, so it's a signal,
not proof — its real protection comes from being combined with the other
signals, and from the fact that anything unusual still has to pass a code
sent to the account's own email/phone. All thresholds are configurable via
`RISK_*` environment variables and can be tuned as real usage data comes in,
per the "start conservative, tighten based on false-positive rate" approach
from the original security design.

## What's new in this build: Loans & Guarantors

**A deliberate design decision, made explicit**: "savings" throughout this
module means **wallet balance** (available balance, specifically), not
cumulative historical contributions — contributions are money that has
already left the wallet permanently (paid to the cooperative), so they can't
be what gets locked as loan collateral. Only money still sitting in the
wallet can be locked. This also matches the "Save Money" wallet concept from
the app design.

- **`GET /memberships/:membershipId/loans/eligibility`** — maximum loan
  amount = available wallet balance × the cooperative's configured
  `loanMultiplier` (default 2x).
- **`POST /memberships/:membershipId/loans`** — request a loan. The
  guarantor (another active member of the same cooperative) is re-verified
  server-side to have sufficient available balance — never trusted at face
  value. Nothing is locked yet at this point.
- **`POST /memberships/:membershipId/loans/:loanId/repay`** — partial
  repayments are allowed here (unlike contributions, which require an exact
  amount) — a deliberate, sensible difference since loans are commonly paid
  down gradually. Overpaying past the outstanding balance is rejected.
  Fully repaying automatically releases the guarantor's locked collateral.
- **Interest**: simple (non-compounding) interest on the original principal,
  snapshotted from the cooperative's rate at request time. "Monthly" is
  currently approximated as a flat 30-day period rather than exact calendar
  months — flagged as a known simplification to refine before this is relied
  on for precise financial reporting.

### Admin loan management — real separation of duties, enforced in code

This was an explicit security requirement from our design conversation
(control #25), and it's implemented as an actual code check, not just policy:

- **`POST /admin/cooperatives/:cooperativeId/loans/:loanId/approve`** — marks
  a loan vetted. **Does not move any money or lock any collateral.**
- **`POST /admin/cooperatives/:cooperativeId/loans/:loanId/disburse`** — the
  separate, second action that actually locks the guarantor's collateral and
  credits the borrower's wallet. **If the disbursing admin is the same person
  who approved the loan, this is rejected outright** — a different admin
  must complete this step. Re-validates the guarantor's available balance
  fresh at this moment (it may have changed since the request), and if
  crediting the borrower fails after collateral was already locked, the
  collateral is immediately released rather than left stranded.
- **`POST /admin/cooperatives/:cooperativeId/loans/:loanId/reject`**

**Operational note**: a cooperative with only one admin can never disburse
their own approved loans under this rule — that's the honest cost of true
separation of duties. In practice, a `SUPER_ADMIN` can act as the second
approver/disburser for small cooperatives with a single dedicated admin.

The admin dashboard's `pendingLoans` count and the "Recent Activity" feed now
reflect real loan data instead of the placeholder 0 from the previous build.

## What's new in this build: Admin Dashboard

All admin routes live under `/admin` and are protected by `CooperativeScopeGuard`
— a `COOPERATIVE_ADMIN` can only ever access their own cooperative's data (a
mismatched `:cooperativeId` returns 404, not 403, so they can't even confirm
another cooperative's ID exists); a `SUPER_ADMIN` can access any cooperative.

- **`GET /admin/cooperatives/:cooperativeId/dashboard`** — total members,
  contributed count, overdue count, and `pendingLoans` (loans in `REQUESTED`
  status awaiting admin approval).
- **`GET /admin/cooperatives/:cooperativeId/members`** — every active member
  with their current-period contribution status.
- **`GET /admin/cooperatives/:cooperativeId/members/overdue`** — matches the
  "View Overdue Members" panel.
- **`GET /admin/cooperatives/:cooperativeId/payments/recent`** — a read-only
  oversight view. Note: there's no manual "approve payment" step in this
  design — every payment is already confirmed automatically (independent
  provider verification for wallet funding, atomic exact-amount transaction
  for contributions) before it's ever recorded, so this is for visibility,
  not approval.
- **`GET /admin/cooperatives/:cooperativeId/activity`** — the merged, sorted
  "Recent Activity" feed (payments, new members, payment adjustments).
- **`POST /admin/cooperatives/:cooperativeId/announcements`** — sends a real
  email via Brevo to the resolved audience (`ALL`, `OVERDUE`, or `SPECIAL`
  with specific membership IDs — each one re-verified server-side to belong
  to that cooperative). **"Schedule for later" is not wired to a real job
  runner yet** — setting `sendImmediately: false` just saves an unsent draft.
- **`POST /admin/cooperatives/:cooperativeId/payments/:ledgerEntryId/reverse`**
  — the audited Payment Adjustment flow: credits the wallet back, reopens the
  contribution obligation, and writes a full before/after `AuditLog` entry.
  Requires both `reason` and `memberConsentNote` — matches our design
  decision that members raise disputes with the admin as a human process,
  never self-report them into the system. Can only happen once per payment.
- **`PATCH /admin/users/:userId/role`** (`SUPER_ADMIN` only) — the only way a
  `COOPERATIVE_ADMIN` or `SUPER_ADMIN` account gets created. No self-service
  privilege escalation exists anywhere in this API.
- **`GET /admin/van-providers/health`** / **`POST /admin/van-providers/active`**
  (`SUPER_ADMIN` only) — the VAN provider health display and manual failover
  toggle from the original system design.

### Bootstrapping your first SUPER_ADMIN

Since `PATCH /admin/users/:userId/role` itself requires an existing
`SUPER_ADMIN` to call it, the very first one has to be created directly in
the database — there's no way around this chicken-and-egg problem, and that's
intentional (a self-service path to become `SUPER_ADMIN` would be a serious
privilege-escalation hole). Register a normal account through the API, then
open `npx prisma studio`, find that user in the **User** table, and manually
set `role` to `SUPER_ADMIN`. From then on, that account can promote anyone
else through the real endpoint.

## What's new in this build: Swagger Docs & Notifications (Brevo)

- **Swagger/OpenAPI** — every DTO's validation rules are reflected
  automatically (via the `@nestjs/swagger` CLI plugin configured in
  `nest-cli.json`, which reads your existing `class-validator` decorators —
  no manual annotation needed per field). Every protected route is marked
  with a padlock in the UI; click **Authorize** at the top and paste an
  `accessToken` to test protected routes directly from the docs page. The two
  webhook controllers are intentionally excluded, since they're called by
  Monnify/Paystack, not by your app teams.
- **`src/notifications`** — a Brevo integration for email and SMS, verified
  against Brevo's live API docs:
  - `providers/brevo.provider.ts` — raw API calls (`POST /v3/smtp/email` for
    email, `POST /v3/transactionalSMS/send` for SMS).
  - `notifications.service.ts` — the actual methods other modules call:
    `sendOtpEmail`, `sendOtpSms`, `sendWelcomeEmail`, `sendAlertEmail`, and
    `sendSecurityConfirmationEmail` (already built and ready for the
    adaptive-authentication flow planned for the Admin module).
  - Marked `@Global()` — any future module (loans, admin, announcements) can
    inject `NotificationsService` without re-importing anything.
- **`src/otp`** — reusable OTP generation/verification: 6-digit codes,
  hashed at rest (never stored plain), rate-limited to 5 wrong guesses per
  code, expire after `OTP_EXPIRY_MINUTES` (default 10). This is genuinely
  reusable infrastructure — it now powers password reset, and is exactly what
  the future admin adaptive-auth confirmation flow will use too.
- **Forgot / Reset Password is now implemented** (this was a gap in the
  original auth module, matching the Figma screens that were never wired up):
  `POST /auth/forgot-password` and `POST /auth/reset-password`. Deliberately
  returns the identical response whether or not the email exists, to prevent
  account enumeration — the same principle already used on login.
- A welcome email now sends on registration (fire-and-forget — a Brevo outage
  never blocks or fails an otherwise-successful registration).

### Important safety switches for local development

Two environment variables protect you from accidentally sending real
emails/SMS (and being charged for SMS) while testing:

- **`NOTIFICATIONS_DRY_RUN`** (default `true`) — when true, nothing is
  actually sent; everything is just logged to your console, including the
  OTP code itself, so you can copy it straight from your terminal to test
  the reset-password flow end to end without needing Brevo configured at all.
- **`BREVO_EMAIL_SANDBOX`** (default `true`) — Brevo-specific: when true and
  dry-run is off, emails are sent through Brevo's real API (so you can verify
  the integration itself works) but flagged so Brevo doesn't actually deliver
  them. There is no SMS equivalent from Brevo, which is exactly why dry-run
  is the primary safety net for SMS.

**Set both to `false` only when you intentionally want real delivery.**

This build has been cross-checked against Monnify's and Paystack's live
documentation (not just training knowledge), and several real corrections
came out of that — documented below so you know exactly what changed and why.

## What's new in this build: Contribution Payments

- `src/contributions/contributions.service.ts` — the core payment flow:
  - **Exact-amount enforcement, server-side.** A member cannot pay more or
    less than the cooperative's configured contribution amount plus any late
    penalty — calculated fresh by the server every time, never trusted from
    the client. Tested explicitly in `contributions.service.spec.ts`.
  - **One atomic transaction for three writes.** Debiting the wallet,
    recording the cooperative-side ledger entry, and marking the obligation
    PAID all happen inside a single Serializable database transaction — all
    three succeed together or none do. This required refactoring
    `WalletService.debit()` into a transaction-composable primitive
    (`debitWithinTransaction`) that other services can include in their own
    transaction, since a service can't cleanly nest one `$transaction` call
    inside another.
  - **Idempotent, with a client-supplied key.** `PayContributionDto` requires
    an `idempotencyKey` (a UUID generated by the client before the request is
    sent) — this is what makes a retried request, from a dropped connection
    or a double-tapped button, safe: the same key returns the original
    result instead of double-charging.
  - **Late penalties applied automatically**, matching the "3 days overdue,
    +₦500" pattern from the contribution summary screen — computed from the
    cooperative's configured `latePenaltyAmount`, applied once a period's due
    date has passed, and locked in permanently once paid.
  - Obligations for a given membership + period are created lazily on first
    access (no cron job needed for this to work), and a member can pay for a
    past overdue period (catching up on arrears) but never a future one.
- `GET /memberships/:membershipId/contributions/summary` — cooperative name,
  period, base amount, penalty, total due (matches the "Pay Monthly
  Contribution" screen exactly).
- `POST /memberships/:membershipId/contributions/pay` — the payment itself.
- `GET /memberships/:membershipId/contributions/history` — past payments for
  that membership.

## Corrections made after reading the actual Monnify/Paystack docs

- **BVN is mandatory for Monnify reserved accounts.** Their API rejects
  account creation without it. Since our security design never stores a raw
  BVN, the flow now accepts the BVN as a one-time input, uses it in-memory for
  exactly one outbound call to Monnify, and persists only a SHA-256 hash
  (`User.bvnHash`) for duplicate detection — never the plaintext number. See
  `WalletService.verifyBvnAndProvisionAccount()`.
- **Monnify's reserved-account response nests bank details in an `accounts`
  array**, not flat top-level fields — fixed in `monnify.provider.ts`.
- **Monnify does NOT send the `monnify-signature` header in sandbox at all** —
  confirmed directly from their docs. A guard that always requires a valid
  signature would make sandbox testing entirely impossible. `MonnifyWebhookGuard`
  now allows a missing signature only in non-production, logs it loudly, and
  relies on the webhook handler's independent re-verification call (which
  still happens regardless) as the real safety net in that environment. In
  production, a missing or invalid signature is still always rejected.
- Endpoint paths, the HMAC-SHA512 signature formula, and response field names
  for `verifyTransaction()` were confirmed correct as originally written.

## What's new in this build: Paystack Withdrawals

- `src/payments/providers/paystack.provider.ts` — bank list, account
  resolution (confirms a destination account before sending money), transfer
  recipient creation, transfer initiation, and independent transfer
  verification. Signature verification uses HMAC-SHA512 with the header
  `x-paystack-signature`, confirmed against Paystack's docs.
- `src/wallet/withdrawal.controller.ts` — `GET /wallet/banks` (for the "Choose
  your bank" dropdown) and `POST /wallet/withdraw`.
- `WalletService.initiateWithdrawal()` — resolves the account, debits the
  wallet immediately (reserving funds using the same race-condition-safe
  `debit()`), then initiates the Paystack transfer. If Paystack's call fails
  outright, the debit is immediately reversed — the member's balance is never
  left in limbo.
- `WalletService.resolveWithdrawalFromWebhook()` — called from the Paystack
  webhook, after signature verification AND an independent re-verification
  call to Paystack. If the transfer ultimately failed or was reversed, the
  wallet is credited back automatically.
- A new `WithdrawalRequest` table tracks each attempt through a real state
  machine (`PENDING → SUCCESSFUL` / `FAILED` / `REVERSED` / `OTP_REQUIRED`),
  rather than inferring status from a single ledger entry.

**Important operational note**: Paystack transfers can require manual OTP
confirmation depending on your account's dashboard settings. For members'
withdrawals to complete automatically (rather than getting stuck needing your
manual OTP entry every time), go to **Paystack Dashboard → Settings →
Preferences** and uncheck **"Confirm transfers before sending."** If this is
still enabled, withdrawals will land in the `OTP_REQUIRED` state, and this is
logged as an error so it doesn't fail silently.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create your `.env` file**
   ```bash
   cp .env.example .env
   ```
   Fill in `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
   `MONNIFY_BASE_URL`/`MONNIFY_API_KEY`/`MONNIFY_SECRET_KEY`/`MONNIFY_CONTRACT_CODE`
   as before, plus:
   - `PAYSTACK_SECRET_KEY` — from your Paystack dashboard (test key to start).
   - `PAYSTACK_BASE_URL` — defaults to `https://api.paystack.co`, no change needed.
   - `BREVO_API_KEY` — from your Brevo account: **Settings → SMTP & API → API Keys**.
   - `BREVO_SENDER_EMAIL` — must be a sender you've verified in Brevo (**Settings → Senders**).
   - Leave `NOTIFICATIONS_DRY_RUN=true` and `BREVO_EMAIL_SANDBOX=true` for now — see the safety-switches note above.

3. **Generate the Prisma client and run the migration** (adds `PlatformSetting`,
   `WithdrawalRequest`, the `Otp` table, renames the BVN field to `bvnHash` —
   no schema changes were needed for contributions, since
   `ContributionObligation` and `LedgerEntry` already existed in the original
   design)
   ```bash
   npx prisma generate
   npx prisma migrate dev --name add_adaptive_authentication
   ```

4. **Run the tests**
   ```bash
   npm test
   ```

5. **Run the API**
   ```bash
   npm run start:dev
   ```

## Testing the full money flow locally

```bash
ngrok http 3000
```

Set both webhook URLs in their respective dashboards:
- Monnify: `https://<subdomain>.ngrok.io/api/v1/webhooks/monnify`
- Paystack: `https://<subdomain>.ngrok.io/api/v1/webhooks/paystack`

```bash
# 1. Register + login to get an accessToken

# 2. Verify BVN + generate a dedicated virtual account (use a Monnify sandbox test BVN)
curl -X POST http://localhost:3000/api/v1/wallet/virtual-account \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"bvn":"22222222226"}'

# 3. Fund it via Monnify's sandbox payment simulator, then check balance:
curl http://localhost:3000/api/v1/wallet/me \
  -H "Authorization: Bearer <accessToken>"

# 4. List banks for the withdrawal dropdown
curl http://localhost:3000/api/v1/wallet/banks \
  -H "Authorization: Bearer <accessToken>"

# 5. Withdraw to a test bank account
curl -X POST http://localhost:3000/api/v1/wallet/withdraw \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"1000.00","bankAccountNumber":"0000000000","bankCode":"058"}'

# 6. Join a cooperative, then check what's owed
curl -X POST http://localhost:3000/api/v1/memberships/join \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"cooperativeCode":"CEDAROAKS123"}'
# (use the returned membership id below)

curl http://localhost:3000/api/v1/memberships/<membershipId>/contributions/summary \
  -H "Authorization: Bearer <accessToken>"

# 7. Pay it — amount must match totalDue from the summary EXACTLY, or this is rejected
curl -X POST http://localhost:3000/api/v1/memberships/<membershipId>/contributions/pay \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"50000.00","idempotencyKey":"'$(node -e "console.log(require('crypto').randomUUID())")'"}'
```

## Security notes specific to this build

- Passwords hashed with **argon2id**. Refresh tokens stored as **hashes only**.
- Every route protected by default; must opt out explicitly with `@Public()`.
- Global `ValidationPipe` set to `whitelist: true, forbidNonWhitelisted: true` —
  any field not declared in a DTO is rejected outright.
- Wallet balance is **never a stored, directly-mutated field** — always derived
  from ledger entries, per our design.
- `debit()` uses a **Serializable** database transaction specifically to close
  the race-condition window where two concurrent payment requests could both
  read "sufficient balance" and overdraw the wallet.
- Idempotency is enforced by a real **unique database constraint**, not just
  application-level checking — even a bug in the application logic can't bypass
  it, because the database itself will reject a duplicate key.
- The Monnify webhook is verified twice before anything is credited: once via
  **HMAC-SHA512 signature check** (proves the request came from Monnify), and
  once via an **independent call back to Monnify's own transaction API**
  (proves the payload's claims are actually true) — the payload alone is never
  sufficient grounds to move money, per our "never trust external responses" rule.
- Webhook signature verification uses **`crypto.timingSafeEqual`**, not `===`,
  specifically to prevent a timing-attack from being used to guess a valid
  signature one byte at a time.
- Withdrawals follow the identical "never trust the initial response" pattern:
  Paystack's immediate reply to `POST /transfer` is provisional (`pending`),
  never final — only the webhook plus an independent `GET /transfer/verify`
  call decides whether a withdrawal actually succeeded, failed, or reversed.
- If a withdrawal's outbound Paystack call fails outright, or the transfer is
  later reported failed/reversed, the wallet is **automatically credited
  back** — money reserved for a withdrawal is never simply lost if the
  transfer doesn't go through.
- The destination bank account is **resolved and confirmed** (via Paystack's
  `/bank/resolve`) before any recipient or transfer is created, catching
  typos before money is sent to the wrong account.
- Contribution payments enforce the **exact amount** server-side, recomputed
  fresh from the cooperative's configuration on every request — never trusted
  from the client, even though the app UI will of course display the correct
  figure to the member.
- The wallet debit, cooperative ledger entry, and obligation status update
  for a contribution payment are **one atomic transaction** — there is no
  window where a member's wallet is debited but the payment isn't recorded,
  or vice versa.

## What's NOT in this build yet (coming next)

- Backup VAN provider adapters (pending their documentation) — they'll
  implement the same `VanProviderAdapter` interface as Monnify and register
  into `VanProviderRegistry` the same way.
- Adaptive auth thresholds are configured with sensible defaults but not yet
  tuned against real usage data — expect to adjust `RISK_*` env vars once you
  see actual false-positive rates.
- `TRUST_PROXY_HOPS` must be set correctly in production (typically `1`
  behind a single load balancer) or every login will appear to come from the
  proxy's own IP, making the network-based risk signal meaningless. Left at
  `0` by default for local development.
- No admin UI/endpoint yet to see or manually clear a member's login history
  or forcibly untrust a device — currently a Prisma Studio operation.
- A background reconciliation job for withdrawals stuck in `PENDING` past a
  reasonable threshold (belt-and-suspenders alongside the webhook).
- Announcement scheduling ("Schedule for later") isn't wired to a real job
  runner yet — `sendImmediately: false` currently just saves an unsent draft.
- Auto-failover for VAN providers based on health checks — the manual
  SUPER_ADMIN toggle exists (`POST /admin/van-providers/active`), but nothing
  yet automatically switches providers when the active one degrades.
- Loan interest uses a flat 30-day approximation for "monthly" and simple
  (non-compounding) interest — refine to exact calendar-month billing cycles
  before relying on it for real financial reporting.
- Loan default handling: the `DEFAULTED` status exists in the schema, but
  nothing moves a loan into it yet, and there's no mechanism to draw on the
  guarantor's locked collateral if a borrower defaults.

## If something doesn't run

Paste the exact error message back into this chat and we'll fix it together.

