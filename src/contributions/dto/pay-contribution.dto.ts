import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class PayContributionDto {
  // Validated as a decimal string, not a JS number — see the recurring
  // reasoning across this codebase: JSON numbers can lose precision in ways
  // that break exact-amount comparisons for money.
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'Amount must be a valid monetary value.' })
  amount: string;

  // Generated client-side BEFORE the request is sent, and resent unchanged on
  // any retry. This is what makes "poor network causes a retry" safe — see
  // the "what happens on poor network" answer in the design doc. The server
  // never accepts this as proof of anything; it's purely a dedup key.
  @IsUUID()
  idempotencyKey: string;

  // Optional — defaults to the current calendar period if omitted. Format
  // YYYY-MM. Allows paying an overdue PAST period (catching up on arrears),
  // but never a future one — validated server-side in the service, not just
  // here, since format validity and business validity are different checks.
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Period must be in YYYY-MM format.' })
  period?: string;
}
