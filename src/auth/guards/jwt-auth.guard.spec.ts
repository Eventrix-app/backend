import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

function makeContext(authHeader?: string): ExecutionContext {
  const request = { headers: { authorization: authHeader } } as any;
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeContextWithRequest(authHeader?: string): { context: ExecutionContext; request: any } {
  const request = { headers: { authorization: authHeader } } as any;
  const context = {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard — session revocation', () => {
  let guard: JwtAuthGuard;
  let mockJwtService: { verifyAsync: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let mockUsersRepo: { findOne: jest.Mock };
  let mockSessionsRepo: { findOne: jest.Mock };
  let reflector: Reflector;

  const basePayload = { id: 'user-1', email: 'u@example.com', roles: ['user'], full_name: 'U', iat: 1000 };
  const activeUser = { id: 'user-1', isBanned: false, deletedAt: null, passwordChangedAt: null };

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    mockJwtService = { verifyAsync: jest.fn() };
    mockConfigService = { get: jest.fn().mockReturnValue('test-secret') };
    mockUsersRepo = { findOne: jest.fn().mockResolvedValue(activeUser) };
    mockSessionsRepo = { findOne: jest.fn() };

    guard = new JwtAuthGuard(
      reflector,
      mockJwtService as any,
      mockConfigService as any,
      mockUsersRepo as any,
      mockSessionsRepo as any,
    );
  });

  it('allows a token with no jti through untracked (pre-existing tokens keep working)', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: undefined });

    await expect(guard.canActivate(makeContext('Bearer sometoken'))).resolves.toBe(true);
    expect(mockSessionsRepo.findOne).not.toHaveBeenCalled();
  });

  it('allows a token whose session is active and unrevoked', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: 'session-1' });
    mockSessionsRepo.findOne.mockResolvedValue({ id: 'session-1', userId: 'user-1', revokedAt: null });

    await expect(guard.canActivate(makeContext('Bearer sometoken'))).resolves.toBe(true);
  });

  it('rejects a token whose session has been revoked', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: 'session-1' });
    mockSessionsRepo.findOne.mockResolvedValue({ id: 'session-1', userId: 'user-1', revokedAt: new Date() });

    await expect(guard.canActivate(makeContext('Bearer sometoken'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose session no longer exists', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: 'deleted-session' });
    mockSessionsRepo.findOne.mockResolvedValue(null);

    await expect(guard.canActivate(makeContext('Bearer sometoken'))).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token whose jti belongs to a different user's session", async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: 'session-1' });
    mockSessionsRepo.findOne.mockResolvedValue({ id: 'session-1', userId: 'someone-else', revokedAt: null });

    await expect(guard.canActivate(makeContext('Bearer sometoken'))).rejects.toThrow(UnauthorizedException);
  });
});

// A @Public() route (EventsController.findOne/findTicketTypes/findMedia, e.g.) still wants
// req.user populated when a valid token IS sent, so an organizer viewing their own
// not-yet-approved event gets the richer response instead of the anonymous one — without
// ever blocking the request over a missing/invalid/banned token, since the route is public.
describe('JwtAuthGuard — optional auth on @Public() routes', () => {
  let guard: JwtAuthGuard;
  let mockJwtService: { verifyAsync: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let mockUsersRepo: { findOne: jest.Mock };
  let mockSessionsRepo: { findOne: jest.Mock };
  let reflector: Reflector;

  const basePayload = { id: 'user-1', email: 'u@example.com', roles: ['user'], full_name: 'U', iat: 1000 };
  const activeUser = { id: 'user-1', isBanned: false, deletedAt: null, passwordChangedAt: null };

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    mockJwtService = { verifyAsync: jest.fn() };
    mockConfigService = { get: jest.fn().mockReturnValue('test-secret') };
    mockUsersRepo = { findOne: jest.fn().mockResolvedValue(activeUser) };
    mockSessionsRepo = { findOne: jest.fn() };

    guard = new JwtAuthGuard(
      reflector,
      mockJwtService as any,
      mockConfigService as any,
      mockUsersRepo as any,
      mockSessionsRepo as any,
    );
  });

  it('proceeds anonymously when no Authorization header is sent', async () => {
    const { context, request } = makeContextWithRequest(undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('attaches req.user when a valid token is sent', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: undefined });
    const { context, request } = makeContextWithRequest('Bearer sometoken');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ ...basePayload, jti: undefined });
  });

  it('proceeds anonymously (does not throw) on an invalid/expired token', async () => {
    mockJwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const { context, request } = makeContextWithRequest('Bearer sometoken');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('proceeds anonymously (does not throw) for a banned account', async () => {
    mockJwtService.verifyAsync.mockResolvedValue({ ...basePayload, jti: undefined });
    mockUsersRepo.findOne.mockResolvedValue({ ...activeUser, isBanned: true });
    const { context, request } = makeContextWithRequest('Bearer sometoken');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});
