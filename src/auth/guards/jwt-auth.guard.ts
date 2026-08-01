import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { JwtPayload } from '../jwt.util';
import { User } from '../../entities/user.entity';
import { UserSession } from '../../entities/user-session.entity';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(UserSession)
    private readonly sessionsRepository: Repository<UserSession>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // This guard is registered globally (APP_GUARD). Its request/header-reading logic only
    // makes sense for HTTP — chat no longer runs its own WS gateway (see chat-realtime.service.ts),
    // but this stays as a defensive no-op for any non-HTTP execution context.
    if (context.getType() !== 'http') {
      return true;
    }

    // Routes marked @Public() don't require authentication — but several of them
    // (EventsController.findOne/findTicketTypes/findMedia) branch on `req.user?.id` to give
    // a logged-in caller a richer response (e.g. an organizer viewing their own not-yet-
    // approved event) while still allowing anonymous access. That only works if this guard
    // still verifies a token when one is present; returning early here left `req.user`
    // permanently undefined on every @Public() route regardless of whether a valid Bearer
    // token was sent, so those owner/admin checks silently always failed — an organizer
    // could never see their own pending/draft/rejected event's detail page. `isPublic` below
    // therefore only controls whether a MISSING or INVALID token is tolerated, not whether
    // a present one gets parsed.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (isPublic) return true;
      throw new UnauthorizedException(
        'Missing or malformed Authorization header',
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Empty bearer token');
    }

    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      // We deliberately refuse to verify against any fallback. This is a server-misconfiguration,
      // not a user error — fail closed for a route that actually requires auth. A public
      // route degrades to anonymous instead of taking down browsing entirely on this
      // misconfiguration.
      this.logger.error(
        'JWT_SECRET is not configured; refusing to authenticate request',
      );
      if (isPublic) return true;
      throw new UnauthorizedException('Authentication is not configured');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret,
      });

      // The JWT itself is stateless — banning a user (AdminService.banUser) or soft-
      // deleting their account only takes effect at their *next login* unless we check
      // live state here too. A still-valid token from before the ban would otherwise
      // keep working for up to its full 1h lifetime.
      const user = await this.usersRepository.findOne({
        where: { id: payload.id },
        select: ['id', 'isBanned', 'deletedAt', 'passwordChangedAt'],
        withDeleted: true,
      });
      if (!user || user.isBanned || user.deletedAt) {
        throw new UnauthorizedException('Account is no longer active');
      }

      // Same "stateless token" gap as above, but for a password change/reset: without this,
      // a token issued before the account owner changed their password (or a stolen/leaked
      // token an attacker is still using) keeps working for the rest of its ~2-day TTL even
      // after the legitimate user resets their password specifically to lock the attacker
      // out. `iat` is in seconds since epoch (standard JWT claim, added automatically by
      // jwtService.sign); passwordChangedAt is only set on an actual password change, so
      // this is a no-op for every token issued after the account's last (or only) password.
      if (
        user.passwordChangedAt &&
        typeof payload.iat === 'number' &&
        payload.iat * 1000 < user.passwordChangedAt.getTime()
      ) {
        throw new UnauthorizedException('Session expired — please log in again');
      }

      // Per-session revocation ("log out this device" / "log out other devices" in
      // Settings). `jti` is optional so tokens issued before this field existed keep
      // working untracked rather than mass-logging-out every session on deploy — only
      // tokens that do carry one are held to this check.
      if (payload.jti) {
        const session = await this.sessionsRepository.findOne({
          where: { id: payload.jti },
          select: ['id', 'userId', 'revokedAt'],
        });
        if (!session || session.userId !== payload.id || session.revokedAt) {
          throw new UnauthorizedException('This session has been signed out');
        }
      }

      // Attach the verified payload for downstream handlers (e.g. RolesGuard, @GetUser())
      (request as Request & { user?: JwtPayload }).user = payload;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      this.logger.warn(`JWT verification failed: ${message}`);
      // A public route must stay reachable even when the caller happens to send a stale/
      // invalid/banned-account token alongside it (e.g. a logged-out-elsewhere session
      // still cached on device) — fall back to anonymous rather than blocking the request.
      if (isPublic) return true;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
