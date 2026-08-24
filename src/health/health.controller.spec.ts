import { HealthController } from './health.controller';

describe('HealthController', () => {
  let health: { check: jest.Mock };
  let db: { pingCheck: jest.Mock };
  let cache: { isEnabled: boolean };
  let controller: HealthController;
  const originalTimeout = process.env.HEALTH_DB_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.HEALTH_DB_TIMEOUT_MS;
    health = { check: jest.fn().mockResolvedValue({ status: 'ok' }) };
    db = { pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }) };
    cache = { isEnabled: true };
    controller = new HealthController(health as any, db as any, cache as any);
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.HEALTH_DB_TIMEOUT_MS;
    else process.env.HEALTH_DB_TIMEOUT_MS = originalTimeout;
  });

  // Liveness must not touch the database: a platform restarting an otherwise healthy instance
  // over a database blip turns a dependency outage into an availability one.
  it('answers liveness without touching the database', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(db.pingCheck).not.toHaveBeenCalled();
  });

  it('pings the database for readiness', async () => {
    await controller.ready();

    expect(health.check).toHaveBeenCalledTimes(1);
    const [[probe]] = health.check.mock.calls[0];
    await probe();
    expect(db.pingCheck).toHaveBeenCalledWith('database', expect.objectContaining({ timeout: 5000 }));
  });

  // Measured, not guessed: a cold connection to the cross-region database spends ~1.8s in TLS
  // handshake alone, so a budget under that reports "down" for a database that is merely far.
  it('defaults to a budget that survives a cold cross-region handshake', async () => {
    await controller.ready();
    const [[probe]] = health.check.mock.calls[0];
    await probe();

    const { timeout } = db.pingCheck.mock.calls[0][1];
    expect(timeout).toBeGreaterThan(2000);
  });

  it('lets HEALTH_DB_TIMEOUT_MS override the budget', async () => {
    process.env.HEALTH_DB_TIMEOUT_MS = '9000';

    await controller.ready();
    const [[probe]] = health.check.mock.calls[0];
    await probe();

    expect(db.pingCheck).toHaveBeenCalledWith('database', expect.objectContaining({ timeout: 9000 }));
  });
});
