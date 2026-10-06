import { IsEnum, IsUUID, ValidateIf } from 'class-validator';

export enum AssignableRole {
  MEMBER = 'MEMBER',
  COOPERATIVE_ADMIN = 'COOPERATIVE_ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export class AssignRoleDto {
  @IsEnum(AssignableRole)
  role: AssignableRole;

  // Required when promoting someone to COOPERATIVE_ADMIN — which cooperative
  // they'll administer. Not required (and cleared server-side) for MEMBER
  // and SUPER_ADMIN.
  @ValidateIf((dto) => dto.role === AssignableRole.COOPERATIVE_ADMIN)
  @IsUUID()
  cooperativeId?: string;
}
