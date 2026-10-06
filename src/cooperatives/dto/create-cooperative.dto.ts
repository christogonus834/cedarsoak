import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCooperativeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  code: string; // e.g. "CEDAROAKS123" — must be unique, enforced at the DB level too

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @IsString()
  membershipFee: string; // decimal as string, parsed server-side — never trust float precision from JSON

  @IsString()
  contributionAmount: string;
}
