import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

// Exported for the same reason as AuthService.TokenPair — this type appears
// in a public method's signature (validate()), which requires it to be
// nameable for TypeScript's declaration emission.
export interface JwtPayload {
  sub: string; // userId
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.accessSecret'),
    });
  }

  // This runs on every authenticated request. We re-check the user still exists and
  // is active — a JWT can still be technically valid (unexpired) even after an
  // account has been deactivated/suspended, so we don't trust the token alone.
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, isActive: true, adminOfCooperativeId: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account is not active.');
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      adminOfCooperativeId: user.adminOfCooperativeId,
    };
  }
}
