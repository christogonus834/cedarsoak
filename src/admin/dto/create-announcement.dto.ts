import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export enum AnnouncementType {
  GENERAL = 'GENERAL',
  URGENT = 'URGENT',
  REMINDER = 'REMINDER',
}

export enum AnnouncementAudience {
  ALL = 'ALL',
  OVERDUE = 'OVERDUE',
  SPECIAL = 'SPECIAL',
}

export class CreateAnnouncementDto {
  @IsEnum(AnnouncementType)
  type: AnnouncementType;

  @IsEnum(AnnouncementAudience)
  audience: AnnouncementAudience;

  // Required only when audience is SPECIAL — validated conditionally so the
  // other two audience types don't need to supply an empty array.
  @ValidateIf((dto) => dto.audience === AnnouncementAudience.SPECIAL)
  @IsArray()
  @ArrayNotEmpty({ message: 'At least one membership id is required for a SPECIAL audience.' })
  specialMembershipIds?: string[];

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  subject: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message: string;

  // Matches the "Send Immediately" toggle in the design. Scheduling for a
  // future date/time is NOT implemented in this phase — see the module's
  // README note — so this must currently be true; false is accepted but the
  // announcement is saved as an unsent draft rather than actually scheduled.
  @IsOptional()
  @IsBoolean()
  sendImmediately?: boolean = true;
}
