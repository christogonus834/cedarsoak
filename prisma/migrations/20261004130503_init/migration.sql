-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MEMBER', 'COOPERATIVE_ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'LEFT');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletEntrySource" AS ENUM ('VAN_FUNDING', 'COOPERATIVE_PAYMENT', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'WITHDRAWAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CONTRIBUTION_PAYMENT', 'LOAN_REPAYMENT', 'PAYMENT_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'ACTIVE', 'REPAID', 'DEFAULTED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'OTP_REQUIRED', 'SUCCESSFUL', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "bvnVerified" BOOLEAN NOT NULL DEFAULT false,
    "bvnHash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "adminOfCooperativeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFingerprint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ipPrefix" TEXT,
    "fingerprint" TEXT,
    "hourOfDay" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasons" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT,
    "ipPrefix" TEXT,
    "reasons" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Otp" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "destination" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cooperative" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "membershipFee" DECIMAL(14,2) NOT NULL,
    "contributionAmount" DECIMAL(14,2) NOT NULL,
    "contributionFrequency" TEXT NOT NULL DEFAULT 'monthly',
    "latePenaltyAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "loanInterestPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "loanMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cooperative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "memberIdCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'PENDING',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vanProvider" TEXT,
    "vanAccountNumber" TEXT,
    "vanBankName" TEXT,
    "vanAccountReference" TEXT,
    "lockedBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "source" "WalletEntrySource" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "relatedLedgerEntryId" TEXT,
    "providerReference" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "period" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "walletLedgerEntryId" TEXT,
    "relatedLedgerEntryId" TEXT,
    "loanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributionObligation" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "baseAmount" DECIMAL(14,2) NOT NULL,
    "penaltyAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ContributionObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "borrowerMembershipId" TEXT NOT NULL,
    "guarantorMembershipId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "interestPercent" DECIMAL(5,2) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'REQUESTED',
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "disbursedByUserId" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "rejectedByUserId" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "repaidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "cooperativeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankAccountNumber" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "resolvedAccountName" TEXT,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "paystackTransferCode" TEXT,
    "paystackRecipientCode" TEXT,
    "debitLedgerEntryId" TEXT,
    "reversalLedgerEntryId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "ipAddress" TEXT,
    "deviceInfo" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_bvnHash_key" ON "User"("bvnHash");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_phoneNumber_idx" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFingerprint_userId_fingerprint_key" ON "DeviceFingerprint"("userId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "LoginEvent_userId_createdAt_idx" ON "LoginEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginChallenge_userId_idx" ON "LoginChallenge"("userId");

-- CreateIndex
CREATE INDEX "Otp_userId_purpose_idx" ON "Otp"("userId", "purpose");

-- CreateIndex
CREATE INDEX "Otp_destination_purpose_idx" ON "Otp"("destination", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Cooperative_code_key" ON "Cooperative"("code");

-- CreateIndex
CREATE INDEX "Membership_cooperativeId_status_idx" ON "Membership"("cooperativeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_cooperativeId_key" ON "Membership"("userId", "cooperativeId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_cooperativeId_memberIdCode_key" ON "Membership"("cooperativeId", "memberIdCode");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_vanAccountNumber_key" ON "Wallet"("vanAccountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_vanAccountReference_key" ON "Wallet"("vanAccountReference");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_idempotencyKey_key" ON "WalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_idx" ON "WalletLedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_idempotencyKey_idx" ON "WalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_membershipId_period_idx" ON "LedgerEntry"("membershipId", "period");

-- CreateIndex
CREATE INDEX "LedgerEntry_loanId_idx" ON "LedgerEntry"("loanId");

-- CreateIndex
CREATE INDEX "ContributionObligation_membershipId_status_idx" ON "ContributionObligation"("membershipId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContributionObligation_membershipId_period_key" ON "ContributionObligation"("membershipId", "period");

-- CreateIndex
CREATE INDEX "Loan_cooperativeId_status_idx" ON "Loan"("cooperativeId", "status");

-- CreateIndex
CREATE INDEX "Loan_borrowerMembershipId_idx" ON "Loan"("borrowerMembershipId");

-- CreateIndex
CREATE INDEX "Loan_guarantorMembershipId_idx" ON "Loan"("guarantorMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_debitLedgerEntryId_key" ON "WithdrawalRequest"("debitLedgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_reversalLedgerEntryId_key" ON "WithdrawalRequest"("reversalLedgerEntryId");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_walletId_status_idx" ON "WithdrawalRequest"("walletId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_adminOfCooperativeId_fkey" FOREIGN KEY ("adminOfCooperativeId") REFERENCES "Cooperative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceFingerprint" ADD CONSTRAINT "DeviceFingerprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginChallenge" ADD CONSTRAINT "LoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Otp" ADD CONSTRAINT "Otp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionObligation" ADD CONSTRAINT "ContributionObligation_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_borrowerMembershipId_fkey" FOREIGN KEY ("borrowerMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_guarantorMembershipId_fkey" FOREIGN KEY ("guarantorMembershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_cooperativeId_fkey" FOREIGN KEY ("cooperativeId") REFERENCES "Cooperative"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
