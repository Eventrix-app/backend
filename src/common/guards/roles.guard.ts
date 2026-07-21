import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../../auth/jwt.util';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Same reasoning as JwtAuthGuard: this global guard also fires for WS gateway
    // handlers, which have no HTTP request to read roles off of.
    if (context.getType() !== 'http') {
      return true;
    }

    // Skip role check for @Public() routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() declared — route only requires authentication (handled by JwtAuthGuard)
    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const user = request.user;

    if (!user || !user.roles?.length) {
      // JwtAuthGuard should have populated this. If not, the request never authenticated.
      throw new UnauthorizedException('Authentication required');
    }

    if (!required.some(r => user.roles.includes(r))) {
      throw new ForbiddenException(
        `Insufficient role: requires one of [${required.join(', ')}]`,
      );
    }

    return true;
  }
}
