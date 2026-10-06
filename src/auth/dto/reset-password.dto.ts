import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Code must be exactly 6 digits.' })
  code: string;

  // Same password rules as registration — a password reset should never be
  // allowed to set a weaker password than a new signup would require.
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])/, { message: 'Password must contain both upper and lower case letters.' })
  @Matches(/(?=.*[0-9])/, { message: 'Password must contain at least one number.' })
  @Matches(/(?=.*[!@#$%^&*(),.?":{}|<>])/, { message: 'Password must contain at least one special character.' })
  newPassword: string;
}
