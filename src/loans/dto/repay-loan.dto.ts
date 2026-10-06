import { IsString, IsUUID, Matches } from 'class-validator';

export class RepayLoanDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'Amount must be a valid monetary value.' })
  amount: string;

  // Client-generated, resent unchanged on retry — same idempotency pattern
  // used for contribution payments and withdrawals throughout this codebase.
  @IsUUID()
  idempotencyKey: string;
}
