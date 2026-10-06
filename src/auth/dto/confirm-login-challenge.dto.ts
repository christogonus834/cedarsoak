import { IsString, IsUUID, Matches } from 'class-validator';

export class ConfirmLoginChallengeDto {
  @IsUUID()
  challengeId: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Code must be exactly 6 digits.' })
  code: string;
}
