import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class WithdrawDto {
  // Validated as a decimal string, not a number — see the same reasoning as
  // CreateCooperativeDto: JSON numbers lose precision guarantees that a
  // string parsed into Prisma.Decimal server-side does not.
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'Amount must be a valid monetary value.' })
  amount: string;

  @IsString()
  @Matches(/^\d{10}$/, { message: 'Account number must be exactly 10 digits.' })
  bankAccountNumber: string;

  @IsString()
  @MinLength(2)
  @MaxLength(10)
  bankCode: string;
}
