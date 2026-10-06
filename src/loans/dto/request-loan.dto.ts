import { IsString, IsUUID, Matches } from 'class-validator';

export class RequestLoanDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'Amount must be a valid monetary value.' })
  amount: string;

  // The guarantor's membership within the SAME cooperative — re-verified
  // server-side (never trusted at face value) in LoansService: must be an
  // active membership in this cooperative, must not be the borrower's own,
  // and must have sufficient available wallet balance.
  @IsUUID()
  guarantorMembershipId: string;
}
