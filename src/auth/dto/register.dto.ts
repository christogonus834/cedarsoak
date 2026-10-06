import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// class-validator enforces these rules on every request server-side — the fact that
// the mobile/web app also validates the form client-side (as seen in the "Create Your
// Account" screens) is a UX nicety, not a security boundary. This is the real boundary.
export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email address.' })
  @MaxLength(255)
  email: string;

  @IsString()
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'Phone number is not valid.' })
  phoneNumber: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  lastName: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(72) // argon2/bcrypt-safe upper bound
  @Matches(/(?=.*[a-z])(?=.*[A-Z])/, {
    message: 'Password must contain both upper and lower case letters.',
  })
  @Matches(/(?=.*[0-9])/, { message: 'Password must contain at least one number.' })
  @Matches(/(?=.*[!@#$%^&*(),.?":{}|<>])/, {
    message: 'Password must contain at least one special character.',
  })
  password: string;
}
