// Single source of truth for "what period is it right now" and "when is a
// given period's due date" — extracted here because both ContributionsService
// and the admin dashboard need identical logic, and having two copies drift
// out of sync would be exactly the kind of subtle bug that's hard to notice
// (e.g. admin dashboard shows different overdue counts than what a member's
// own summary shows for the same period).

// Current period in YYYY-MM, based on the SERVER's clock — never derived
// from anything client-supplied, which would let a client claim to be
// paying for (or an admin report on) whatever period is most favorable.
export function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function getPeriodDueDate(period: string): Date {
  const [year, month] = period.split('-').map(Number);
  // Due at the end of the given month, 23:59:59 — day 0 of the *next*
  // month in JS Date math gives the last day of the target month.
  return new Date(year, month, 0, 23, 59, 59);
}

export function isPeriodInFuture(period: string): boolean {
  const [year, month] = period.split('-').map(Number);
  const now = new Date();
  const requestedStart = new Date(year, month - 1, 1);
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return requestedStart > currentStart;
}
