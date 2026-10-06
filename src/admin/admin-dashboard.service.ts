import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getCurrentPeriod } from '../common/utils/period.util';

export interface ActivityItem {
  type: 'CONTRIBUTION_PAID' | 'NEW_MEMBER' | 'PAYMENT_ADJUSTMENT' | 'LOAN_REQUESTED';
  description: string;
  amount?: string;
  occurredAt: Date;
}

@Injectable()
export class AdminDashboardService {
  constructor(private prisma: PrismaService) {}

  // Matches the "48 Total Members / 42 Contributed / 3 Pending Loans / 4
  // Overdue" summary cards from the design. pendingLoans counts loans in
  // REQUESTED status (awaiting admin approval) for this cooperative.
  async getDashboardSummary(cooperativeId: string) {
    const period = getCurrentPeriod();

    const [totalMembers, contributedCount, overdueCount, pendingLoans] = await Promise.all([
      this.prisma.membership.count({ where: { cooperativeId, status: 'ACTIVE' } }),
      this.prisma.contributionObligation.count({
        where: { period, status: 'PAID', membership: { cooperativeId } },
      }),
      this.prisma.contributionObligation.count({
        where: { period, status: 'OVERDUE', membership: { cooperativeId } },
      }),
      this.prisma.loan.count({ where: { cooperativeId, status: 'REQUESTED' } }),
    ]);

    return {
      totalMembers,
      contributed: contributedCount,
      pendingLoans,
      overdue: overdueCount,
      period,
    };
  }

  // Matches the "48 Total Members" list screen — every active member with
  // their current period's contribution status, so the admin can see who's
  // paid without opening each member individually.
  async getMembers(cooperativeId: string, period?: string) {
    const resolvedPeriod = period || getCurrentPeriod();

    const memberships = await this.prisma.membership.findMany({
      where: { cooperativeId, status: 'ACTIVE' },
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } },
        obligations: { where: { period: resolvedPeriod } },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((m) => ({
      membershipId: m.id,
      memberIdCode: m.memberIdCode,
      name: `${m.user.firstName} ${m.user.lastName}`,
      email: m.user.email,
      phoneNumber: m.user.phoneNumber,
      contributionStatus: m.obligations[0]?.status ?? 'PENDING',
      joinedAt: m.joinedAt,
    }));
  }

  // Matches the "4 Members Have Overdue Contribution" panel + "View Overdue
  // Members" action.
  async getOverdueMembers(cooperativeId: string, period?: string) {
    const resolvedPeriod = period || getCurrentPeriod();

    const obligations = await this.prisma.contributionObligation.findMany({
      where: { period: resolvedPeriod, status: 'OVERDUE', membership: { cooperativeId } },
      include: {
        membership: {
          include: { user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } } },
        },
      },
    });

    return obligations.map((o) => ({
      membershipId: o.membershipId,
      name: `${o.membership.user.firstName} ${o.membership.user.lastName}`,
      email: o.membership.user.email,
      phoneNumber: o.membership.user.phoneNumber,
      amountOwed: o.baseAmount.plus(o.penaltyAmount).toFixed(2),
      dueDate: o.dueDate,
    }));
  }

  // Recent contribution payments for the cooperative — this is what powers
  // the admin's "Verify Payments" oversight view. Note: payments are already
  // confirmed automatically before this point (independent provider
  // verification for wallet funding, exact-amount + atomic transaction for
  // the contribution itself) — there's no separate manual "approve" step in
  // this design. This is a read-only audit/oversight view, not a queue of
  // things awaiting approval.
  async getRecentPayments(cooperativeId: string, limit = 20) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { type: 'CONTRIBUTION_PAYMENT', membership: { cooperativeId } },
      include: {
        membership: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return entries.map((e) => ({
      ledgerEntryId: e.id,
      membershipId: e.membershipId,
      memberName: `${e.membership.user.firstName} ${e.membership.user.lastName}`,
      amount: e.amount.toFixed(2),
      period: e.period,
      paidAt: e.createdAt,
    }));
  }

  // Matches the "Recent Activity" feed: contribution payments and new member
  // joins, merged and sorted by time. Built from two focused queries and
  // merged in application code rather than a raw SQL UNION — simpler to
  // read and modify as more activity types (loan requests, in Phase 6) get
  // added later.
  async getRecentActivity(cooperativeId: string, limit = 20): Promise<ActivityItem[]> {
    const [payments, newMembers, adjustments, loanRequests] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { type: 'CONTRIBUTION_PAYMENT', membership: { cooperativeId } },
        include: { membership: { include: { user: { select: { firstName: true, lastName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.membership.findMany({
        where: { cooperativeId },
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: { joinedAt: 'desc' },
        take: limit,
      }),
      this.prisma.ledgerEntry.findMany({
        where: { type: 'PAYMENT_ADJUSTMENT', membership: { cooperativeId } },
        include: { membership: { include: { user: { select: { firstName: true, lastName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.loan.findMany({
        where: { cooperativeId },
        include: { borrowerMembership: { include: { user: { select: { firstName: true, lastName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    const activity: ActivityItem[] = [
      ...payments.map((p) => ({
        type: 'CONTRIBUTION_PAID' as const,
        description: `${p.membership.user.firstName} ${p.membership.user.lastName} paid ${p.period} contribution`,
        amount: p.amount.toFixed(2),
        occurredAt: p.createdAt,
      })),
      ...newMembers.map((m) => ({
        type: 'NEW_MEMBER' as const,
        description: `${m.user.firstName} ${m.user.lastName} joined (${m.memberIdCode})`,
        occurredAt: m.joinedAt,
      })),
      ...adjustments.map((a) => ({
        type: 'PAYMENT_ADJUSTMENT' as const,
        description: `Payment adjustment for ${a.membership.user.firstName} ${a.membership.user.lastName}`,
        amount: a.amount.toFixed(2),
        occurredAt: a.createdAt,
      })),
      ...loanRequests.map((l) => ({
        type: 'LOAN_REQUESTED' as const,
        description: `Loan Request — ${l.borrowerMembership.user.firstName} ${l.borrowerMembership.user.lastName} (${l.status})`,
        amount: l.amount.toFixed(2),
        occurredAt: l.createdAt,
      })),
    ];

    return activity.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, limit);
  }
}
