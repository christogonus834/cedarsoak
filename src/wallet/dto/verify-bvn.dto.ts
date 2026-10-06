import { IsString, Matches } from 'class-validator';

export class VerifyBvnDto {
  // Nigerian BVN is always exactly 11 digits. This is the ONLY place in the
  // entire codebase where a raw BVN is accepted — it flows straight through
  // to WalletService.verifyBvnAndProvisionAccount() and is never persisted.
  @IsString()
  @Matches(/^\d{11}$/, { message: 'BVN must be exactly 11 digits.' })
  bvn: string;
}
