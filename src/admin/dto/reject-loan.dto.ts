import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectLoanDto {
  @IsString()
  @MinLength(5, { message: 'Please provide a brief reason for rejection.' })
  @MaxLength(500)
  reason: string;
}
