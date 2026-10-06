import { IsString, MaxLength, MinLength } from 'class-validator';

export class AdjustPaymentDto {
  @IsString()
  @MinLength(10, { message: 'Please provide a clear reason (at least 10 characters).' })
  @MaxLength(500)
  reason: string;

  // Per our design decision: members don't self-report disputes into the
  // system — they raise it with the admin, who acts with the member's
  // consent as part of that human process. This field captures a record of
  // that consent at the time of the adjustment; it's a text note the admin
  // fills in describing how/that consent was obtained, not a technical
  // verification of it.
  @IsString()
  @MinLength(10, { message: 'Please describe how member consent was obtained.' })
  @MaxLength(500)
  memberConsentNote: string;
}
