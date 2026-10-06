# Testing the CedarOaks API — Full Guide

This guide walks through running the app locally and testing every endpoint,
using Postman (recommended), curl, or another HTTP client of your choice. It
assumes you've unzipped the project and opened it in VS Code, but haven't yet
run anything.

---

## 1. Prerequisites

Before you start, make sure you have:

- **Node.js** (v18 or newer) and **npm** installed — check with `node -v`
- A **Supabase** account with a project created (free tier is fine) — this is
  your Postgres database
- A **Monnify** sandbox account (developers.monnify.com) — for wallet funding
- A **Paystack** account with a **test** secret key (dashboard.paystack.com)
  — for withdrawals
- **Postman** (postman.com/downloads) — or an alternative (see Section 6)
- **ngrok** (ngrok.com/download) — only needed later, for testing webhooks

---

## 2. Install and configure

```bash
cd cedaroaks-backend
npm install
cp .env.example .env
```

Now open `.env` and fill in each value. Here's exactly where to find each one:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase dashboard → your project → **Settings → Database → Connection string → URI**. Copy it exactly, including your password. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Generate two different random strings: run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` twice. |
| `MONNIFY_BASE_URL` | Use `https://sandbox.monnify.com` for testing. |
| `MONNIFY_API_KEY` / `MONNIFY_SECRET_KEY` / `MONNIFY_CONTRACT_CODE` | Monnify dashboard → **Settings → API Keys** (sandbox mode). |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → **Settings → API Keys & Webhooks** → copy the **Test Secret Key** (starts with `sk_test_`). |
| `PAYSTACK_BASE_URL` | Leave as `https://api.paystack.co` — no change needed. |
| `DEFAULT_VAN_PROVIDER` | Leave as `MONNIFY`. |

**Do not use live/production keys while testing.** Sandbox and test keys are
free and don't move real money.

---

## 3. Set up the database

```bash
npx prisma generate
npx prisma migrate dev --name init
```

This creates every table in your Supabase database. If this fails, the
error almost always means `DATABASE_URL` is wrong — double-check special
characters in your password are URL-encoded (e.g. `@` becomes `%40`).

### Seed a test cooperative (needed before you can test contributions)

Cooperative creation requires a `SUPER_ADMIN` — and nobody starts as one.
For local testing, the fastest way around this is to create a cooperative
directly in the database using Prisma Studio, a GUI that ships with Prisma:

```bash
npx prisma studio
```

This opens a browser tab at `http://localhost:5555`. Click into the
**Cooperative** table, click **Add record**, and fill in:

| Field | Example value |
|---|---|
| `name` | CedarOaks Cooperative Society |
| `code` | CEDAROAKS123 |
| `membershipFee` | 2000.00 |
| `contributionAmount` | 50000.00 |
| `latePenaltyAmount` | 500.00 |
| `loanInterestPercent` | 2.00 |

Leave other fields at their defaults. Save the record — you now have a
cooperative to join and test contribution payments against.

*(Alternative: once you register your first user via the API, you can also
open the **User** table in Prisma Studio and manually change that one
user's `role` field to `SUPER_ADMIN`, then use the real
`POST /cooperatives` endpoint instead. Either approach works — Prisma
Studio is just faster for one-off local test data.)*

### SUPER_ADMIN bootstrap (needed before you can test Section 8's Admin endpoints)

This is the same trick as above, called out separately because the Admin
endpoints need it too: `PATCH /admin/users/:userId/role` is the real way to
promote someone, but it itself requires an existing `SUPER_ADMIN` to call
it — so the very first one always has to be set directly in Prisma Studio.
Register a user via the API, open `npx prisma studio`, find them in the
**User** table, and set `role` to `SUPER_ADMIN`. From then on, that account
can promote anyone else through the real endpoint instead.

---

## 4. Run the app

```bash
npm run start:dev
```

You should see: `CedarOaks API running on port 3000`

Leave this running in its own terminal for everything below.

---

## 5. Testing with Postman (recommended)

The project includes a ready-to-import Postman collection and environment
in the `postman/` folder:

- `postman/CedarOaks.postman_collection.json`
- `postman/CedarOaks.postman_environment.json`

### Import them

1. Open Postman → click **Import** (top left) → drag in both files, or select them via the file picker.
2. In the top-right environment dropdown, select **CedarOaks - Local**.
3. Open the environment (the eye icon, or **Environments** in the sidebar) and replace the placeholder `monnifySecretKey` and `paystackSecretKey` values with your real sandbox/test secret keys — these are only used for the optional advanced webhook-signature tests in folder 7, and must match what's in your `.env` for those specific requests to work.

### What makes this collection different from a plain list of endpoints

Each request has a **test script** attached that automatically saves values
like `accessToken`, `membershipId`, and `walletId` into your environment
after a successful response. This means you don't need to copy-paste tokens
between requests — just run them **in order, top to bottom**, and each one
feeds the next.

### Run order (full journey, end to end)

The collection is numbered 1–9 in the order to run it. Folder **7** is
optional/advanced and can be skipped on a first pass.

**1. Auth**
1. **Register** — creates a user and saves `accessToken` automatically (the email has a random number pre-filled to avoid collisions on repeat runs).
2. **Login** — on a fresh account this will very likely come back as `{"challengeRequired": true, "challengeId": "..."}` instead of tokens, because a brand-new device/network has no history yet. This is expected, not a bug — see "Adaptive authentication" below.
3. **Confirm Login Challenge** (only needed if step 2 was challenged) — get the 6-digit code from your server console (`[DRY RUN] Email to ...` line, since `NOTIFICATIONS_DRY_RUN=true` by default) and paste it into the request body before sending. This saves `accessToken` for you.
4. Skip **Refresh Token**, **Logout**, **Forgot Password**, **Reset Password** on a first pass — they're independent flows, not required for the rest of the journey.

**2. Users** — **Get My Profile** confirms your token works.

**3. Cooperatives** — **Get Cooperative by Code** looks up the cooperative you seeded in Section 3 (defaults to `CEDAROAKS123`), saves `cooperativeId`. (**Create Cooperative** requires `SUPER_ADMIN` — skip it unless you've done the bootstrap in Section 3.)

**4. Memberships** — **Join Cooperative** joins it, saves `membershipId`.

**5. Wallet**
1. **Verify BVN & Generate Virtual Account** — uses a placeholder sandbox BVN; check Monnify's current sandbox docs for a valid test value if rejected.
2. **Get My Wallet** — balance will be `0.00` until you actually fund it (see "Actually funding the wallet" below).
3. **List Banks**, **Withdraw** — withdrawal will correctly fail with "Insufficient wallet balance" until the wallet has real funds.

**6. Contributions**
1. **Get Contribution Summary** — saves `lastTotalDue`.
2. **Pay Contribution** — pays exactly `lastTotalDue`. This will fail with "Insufficient wallet balance" until the wallet is funded — try it anyway first to see that error, then come back to it after Section 5a.
3. **Get Payment History**.

**9. Loans (member)** — needs a second member in the same cooperative to act as guarantor:
1. Register a second user, log them in, join the same cooperative with them too (repeat folders 1 and 4 with a different email), and fund their wallet. Set the environment variable `guarantorMembershipId` to that second member's `membershipId`.
2. Switch `accessToken` back to the first (borrower) user.
3. **Loan Eligibility** — shows max borrowable amount.
4. **Request Loan** — saves `loanId`.
5. **List My Loans** / **Loan Detail** — check status is `REQUESTED`.
6. Repayment (**Repay Loan**) only works once the loan is `ACTIVE` — that requires folder 8 (Admin) to approve and disburse it first.

**8. Admin** — requires an admin/super-admin `accessToken` (see the SUPER_ADMIN bootstrap note in Section 3):
1. **Dashboard Summary**, **List Members**, **List Overdue Members**, **Recent Payments**, **Recent Activity Feed** — read-only, run anytime.
2. **Send Announcement** — with `NOTIFICATIONS_DRY_RUN=true`, check your server console for one logged line per recipient instead of a real email.
3. **List Loans (filter by status)** then **Approve Loan (Admin A)** — approving moves no money.
4. **Disburse Loan (must be a DIFFERENT admin)** — switch `{{accessToken}}` to a *different* admin (or a `SUPER_ADMIN`) before sending this. If you use the same admin who approved, you should get a 403 — that's separation of duties working correctly, not a bug.
5. Go back to folder 9 and run **Repay Loan** now that the loan is `ACTIVE`.
6. **Reverse a Payment (Payment Adjustment)** — run **Recent Payments** first to capture a `ledgerEntryId`; this can only succeed once per payment.
7. **Assign Role**, **VAN Provider Health** — `SUPER_ADMIN` only.

**7. Webhooks (Advanced)** — optional. See "Testing webhooks locally" below; these two requests simulate signed provider callbacks directly from Postman using CryptoJS, without needing ngrok.

### Adaptive authentication: what you'll see while testing

Because admin/staff accounts are challenged on just **one** signal and members
on **two or more**, expect `Login` to return `challengeRequired: true` fairly
often during testing — every time you use a new `x-device-id`, a new email
account, or test from a genuinely different network. This is the feature
working as designed, not a flaky endpoint. Grab the code from your console
and run **Confirm Login Challenge** immediately after.

### 5a. Actually funding the wallet (can't be done from Postman alone)

Generating a virtual account number is just step one — to see a real balance,
you need to actually send money to it, which happens through Monnify's own
sandbox tools, not through your API:

1. Log into your Monnify sandbox dashboard.
2. Find their test/simulate-payment tool (usually under **Transactions** or
   a dedicated sandbox simulator).
3. Send a test transfer to the account number returned by the "Verify BVN &
   Generate Virtual Account" request.
4. For this to actually reach your app, Monnify needs to send a webhook —
   which means you need **ngrok** running and your webhook URL registered
   in Monnify's dashboard. See Section 7 below.
5. Once the webhook fires (or you manually replay it, see Section 7),
   re-run **Get My Wallet** and you should see the funded balance.

---

## 6. Testing with other tools

The Postman collection uses the standard **Postman Collection v2.1** format,
which several other tools can import directly:

- **Insomnia** — File → Import → select `CedarOaks.postman_collection.json`. Environment variables map over, though you may need to re-enter secret values.
- **Bruno** — supports importing Postman collections from its own import menu.
- **Hoppscotch** (web-based) — has a Postman collection importer under Import/Export.
- **Thunder Client** (VS Code extension) — can import Postman collections directly from within VS Code, which may be convenient since you're already there.

If you'd rather not import anything, every endpoint is documented in
Section 8 below with a plain curl example you can run directly in a
terminal, or adapt into any tool.

---

## 7. Testing webhooks locally (ngrok)

Both Monnify and Paystack need a public URL to send webhooks to. Your
laptop's `localhost` isn't reachable from the internet, so a tunnel is
needed for local testing:

```bash
ngrok http 3000
```

This prints a public URL like `https://a1b2-c3d4.ngrok-free.app`. Set your
webhook URLs using that:

- **Monnify dashboard** → Settings → Webhook URL:
  `https://<your-ngrok-subdomain>.ngrok-free.app/api/v1/webhooks/monnify`
- **Paystack dashboard** → Settings → API Keys & Webhooks → Webhook URL:
  `https://<your-ngrok-subdomain>.ngrok-free.app/api/v1/webhooks/paystack`

Now when you trigger a real sandbox payment or transfer, the provider will
call your locally running app through the tunnel, and you'll see the request
logged in your `npm run start:dev` terminal in real time.

**Note on Monnify sandbox signatures**: Monnify's own documentation states
they do not send the `monnify-signature` header in sandbox mode at all. This
is expected and already handled in the code (see the comments in
`monnify-webhook.guard.ts`) — you'll see a warning logged, not an error.

---

## 8. Full endpoint reference (curl examples)

Replace `<accessToken>` with the value from a login/register response.

### Auth
```bash
# Register
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","phoneNumber":"+2348123340690","firstName":"Mary","lastName":"Ikott","password":"Testpass1!"}'

# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Testpass1!"}'

# Refresh
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}'

# Logout
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}'
```

### Adaptive authentication: what to expect and how to get past it while testing

**A member's very first login is a genuinely new device/network by
definition**, so it's completely normal to sometimes see a
`{"challengeRequired": true, "challengeId": "..."}` response instead of
tokens — this is not a bug. With `NOTIFICATIONS_DRY_RUN=true` (the default),
the 6-digit code is printed straight to your server console as a
`[DRY RUN] Email to ...` line — copy it from there.

**This matters especially for the SUPER_ADMIN bootstrap flow**: since
admin/staff accounts are challenged on ANY single signal, the very first
login of a freshly-promoted SUPER_ADMIN will almost always be challenged
(no device/network history exists for that account yet). This is expected —
just grab the code from your console (or your real email/SMS if dry-run is
off) and confirm it.

```bash
# If login returns challengeRequired, confirm it with the code from your logs:
curl -X POST http://localhost:3000/api/v1/auth/login/confirm \
  -H "Content-Type: application/json" \
  -d '{"challengeId":"<challengeId>","code":"123456"}'
```

Sending a consistent `x-device-id` header (any stable string of 8+
characters) on repeated logins from "the same" test client will get you
recognised as a trusted device after the first successful confirmation,
reducing how often you get challenged during a testing session:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "x-device-id: my-test-device-12345" \
  -d '{"email":"test@example.com","password":"Testpass1!"}'
```

### Users
```bash
curl http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer <accessToken>"
```

### Cooperatives
```bash
# Get by code (public to any authenticated user)
curl http://localhost:3000/api/v1/cooperatives/by-code/CEDAROAKS123 \
  -H "Authorization: Bearer <accessToken>"

# Create (requires SUPER_ADMIN role — see Section 3's seeding note)
curl -X POST http://localhost:3000/api/v1/cooperatives \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"CedarOaks Cooperative Society","code":"CEDAROAKS123","membershipFee":"2000.00","contributionAmount":"50000.00"}'
```

### Memberships
```bash
curl -X POST http://localhost:3000/api/v1/memberships/join \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"cooperativeCode":"CEDAROAKS123"}'

curl http://localhost:3000/api/v1/memberships/mine \
  -H "Authorization: Bearer <accessToken>"
```

### Wallet
```bash
# Verify BVN + generate virtual account
curl -X POST http://localhost:3000/api/v1/wallet/virtual-account \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"bvn":"22222222222"}'

curl http://localhost:3000/api/v1/wallet/me \
  -H "Authorization: Bearer <accessToken>"

curl http://localhost:3000/api/v1/wallet/banks \
  -H "Authorization: Bearer <accessToken>"

curl -X POST http://localhost:3000/api/v1/wallet/withdraw \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"1000.00","bankAccountNumber":"0000000000","bankCode":"058"}'
```

### Contributions
```bash
curl http://localhost:3000/api/v1/memberships/<membershipId>/contributions/summary \
  -H "Authorization: Bearer <accessToken>"

curl -X POST http://localhost:3000/api/v1/memberships/<membershipId>/contributions/pay \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"50000.00","idempotencyKey":"'$(node -e "console.log(require('crypto').randomUUID())")'"}'

curl http://localhost:3000/api/v1/memberships/<membershipId>/contributions/history \
  -H "Authorization: Bearer <accessToken>"
```

### Loans (member-facing)
```bash
# How much can I borrow? (available wallet balance x cooperative loan multiplier)
curl http://localhost:3000/api/v1/memberships/<membershipId>/loans/eligibility \
  -H "Authorization: Bearer <accessToken>"

# Request a loan — guarantorMembershipId must be another ACTIVE member of the SAME cooperative
# with enough available wallet balance to cover the amount
curl -X POST http://localhost:3000/api/v1/memberships/<membershipId>/loans \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"20000.00","guarantorMembershipId":"<guarantorMembershipId>"}'

# List my loans / view one (includes outstanding balance)
curl http://localhost:3000/api/v1/memberships/<membershipId>/loans \
  -H "Authorization: Bearer <accessToken>"
curl http://localhost:3000/api/v1/memberships/<membershipId>/loans/<loanId> \
  -H "Authorization: Bearer <accessToken>"

# Repay (partial repayments are allowed; overpaying is rejected)
curl -X POST http://localhost:3000/api/v1/memberships/<membershipId>/loans/<loanId>/repay \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"amount":"5000.00","idempotencyKey":"'$(node -e "console.log(require('crypto').randomUUID())")'"}'
```

### Admin loan management (approve and disburse MUST be two different admins)
```bash
curl "http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/loans?status=REQUESTED" \
  -H "Authorization: Bearer <adminAAccessToken>"

# Step 1 — Admin A approves (no money moves yet)
curl -X POST http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/loans/<loanId>/approve \
  -H "Authorization: Bearer <adminAAccessToken>"

# Step 2 — Admin B disburses. If Admin A tries this, it is rejected (separation of duties).
# A SUPER_ADMIN can act as the second admin for testing.
curl -X POST http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/loans/<loanId>/disburse \
  -H "Authorization: Bearer <adminBAccessToken>"

# Or reject instead of approving
curl -X POST http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/loans/<loanId>/reject \
  -H "Authorization: Bearer <adminAAccessToken>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Insufficient repayment history"}'
```

### Admin (requires a SUPER_ADMIN or COOPERATIVE_ADMIN accessToken — see Section 3's SUPER_ADMIN bootstrap note)
```bash
# Dashboard summary
curl http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/dashboard \
  -H "Authorization: Bearer <adminAccessToken>"

# Member list with current-period contribution status
curl http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/members \
  -H "Authorization: Bearer <adminAccessToken>"

# Overdue members
curl http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/members/overdue \
  -H "Authorization: Bearer <adminAccessToken>"

# Recent activity feed
curl http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/activity \
  -H "Authorization: Bearer <adminAccessToken>"

# Send an announcement to all members
curl -X POST http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/announcements \
  -H "Authorization: Bearer <adminAccessToken>" \
  -H "Content-Type: application/json" \
  -d '{"type":"GENERAL","audience":"ALL","subject":"Monthly Reminder","message":"Please remember to pay your contribution this month."}'

# Reverse a contribution payment (get <ledgerEntryId> from the recent-payments or history endpoint)
curl -X POST http://localhost:3000/api/v1/admin/cooperatives/<cooperativeId>/payments/<ledgerEntryId>/reverse \
  -H "Authorization: Bearer <adminAccessToken>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Member paid twice by mistake","memberConsentNote":"Member called support and confirmed via phone on 2026-09-26"}'

# Promote a user to COOPERATIVE_ADMIN (SUPER_ADMIN only)
curl -X PATCH http://localhost:3000/api/v1/admin/users/<targetUserId>/role \
  -H "Authorization: Bearer <superAdminAccessToken>" \
  -H "Content-Type: application/json" \
  -d '{"role":"COOPERATIVE_ADMIN","cooperativeId":"<cooperativeId>"}'

# VAN provider health (SUPER_ADMIN only)
curl http://localhost:3000/api/v1/admin/van-providers/health \
  -H "Authorization: Bearer <superAdminAccessToken>"
```

---

## 9. Running the automated test suite

Separate from manual API testing, there's a real Jest test suite covering
the safety-critical logic (ledger math, idempotency, signature verification,
exact-amount enforcement) without needing the server running or a database
connected at all:

```bash
npm test
```

Run this first, before manual testing — if anything fails here, fix it
before spending time testing through Postman, since these tests are
checking the exact logic Postman would otherwise take many manual clicks to
exercise.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required environment variable: X` on startup | You forgot to fill in that value in `.env` |
| Prisma migration fails | `DATABASE_URL` is malformed — check password URL-encoding |
| `401 Unauthorized` on every request | `accessToken` missing/expired — re-run Login; access tokens expire after 15 minutes by default |
| `403 Forbidden` on Create Cooperative | Your user isn't `SUPER_ADMIN` yet — see Section 3's seeding note |
| Monnify virtual account creation fails | Check `MONNIFY_API_KEY`/`SECRET_KEY`/`CONTRACT_CODE` are valid sandbox credentials, and that the BVN you sent is a valid Monnify sandbox test BVN |
| Withdraw fails with "Insufficient wallet balance" | Expected — you haven't actually funded the wallet yet (see Section 5a) |
| Webhook signature fails locally | Make sure ngrok is running and the webhook URL registered with the provider points at your current ngrok subdomain (it changes every time you restart ngrok on the free tier) |
| `Payment amount must be exactly ₦X` | Working as intended — re-fetch the contribution summary and use that exact `totalDue` value |
| Login returns `challengeRequired: true` | Expected, not an error — see "Adaptive authentication" above. Confirm with the code from your console. |
| `401` from `/auth/login/confirm` saying expired/invalid | The challenge expired (`OTP_EXPIRY_MINUTES`, default 10) or was already used — run Login again to get a fresh `challengeId` |
| `404 Cooperative not found` on any `/admin/...` route | Either the `cooperativeId` is wrong, or your admin's `adminOfCooperativeId` doesn't match it — a `COOPERATIVE_ADMIN` can only ever access their own cooperative (this is deliberate; see the README) |
| `403` on **Disburse Loan** | Expected if you used the same admin who approved it — switch to a different admin/`SUPER_ADMIN` token (separation of duties) |
| Loan request rejected: "insufficient available savings" | The guarantor's wallet must be funded (not just have paid contributions) — "savings" means wallet balance in this system, see the README's Loans section |
| `429 Too many sensitive actions` | `BurstLimitGuard` fired — you've performed more than `RISK_BURST_LIMIT` audited admin actions within `RISK_BURST_WINDOW_MINUTES`; wait a few minutes or raise the limit in `.env` for local testing |

If you hit an error not covered here, paste the **exact error message and
which request caused it** back into this chat and we'll work through it
together.
