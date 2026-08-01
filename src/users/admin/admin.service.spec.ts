import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminService } from './admin.service';

// Regression tests: bootstrap() previously relied solely on "no admin accounts exist yet"
// — since the endpoint is permanently @Public(), that alone would silently reopen it to
// any unauthenticated caller if every admin were ever removed post-launch. It now also
// requires a separately-configured ADMIN_BOOTSTRAP_SECRET.
describe('AdminService.bootstrap — secret gate', () => {
  let service: AdminService;
  let mockUsersRepo: any;
  let mockDataSource: any;
  let mockConfigService: any;
  let mockManager: any;

  beforeEach(() => {
    mockUsersRepo = {
      findOne: jest.fn(),
      create: jest.fn((d: any) => d),
      save: jest.fn((d: any) => Promise.resolve({ id: 'admin-1', createdAt: new Date(), updatedAt: new Date(), ...d })),
    };
    mockManager = {
      query: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      getRepository: jest.fn().mockReturnValue(mockUsersRepo),
    };
    mockDataSource = { transaction: jest.fn((cb: any) => cb(mockManager)) };
    mockConfigService = { get: jest.fn() };
    service = new AdminService(mockUsersRepo, mockDataSource, mockConfigService);
  });

  const dto = { email: 'admin@example.com', firstName: 'Ad', lastName: 'Min', username: 'admin', password: 'Password123!' } as any;

  it('rejects when no secret is configured at all', async () => {
    mockConfigService.get.mockReturnValue(undefined);

    await expect(service.bootstrap(dto, 'anything')).rejects.toThrow(UnauthorizedException);
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects when the caller provides no secret', async () => {
    mockConfigService.get.mockReturnValue('correct-secret');

    await expect(service.bootstrap(dto, undefined)).rejects.toThrow(UnauthorizedException);
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects when the caller provides the wrong secret', async () => {
    mockConfigService.get.mockReturnValue('correct-secret');

    await expect(service.bootstrap(dto, 'wrong-secret')).rejects.toThrow(UnauthorizedException);
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it('still enforces the zero-admins check even with a correct secret', async () => {
    mockConfigService.get.mockReturnValue('correct-secret');
    mockManager.count.mockResolvedValue(1);

    await expect(service.bootstrap(dto, 'correct-secret')).rejects.toThrow(ForbiddenException);
  });

  it('creates the first admin when the secret is correct and no admins exist yet', async () => {
    mockConfigService.get.mockReturnValue('correct-secret');
    mockManager.count.mockResolvedValue(0);
    mockUsersRepo.findOne.mockResolvedValue(null);

    const result = await service.bootstrap(dto, 'correct-secret');

    expect(result.email).toBe('admin@example.com');
  });
});
