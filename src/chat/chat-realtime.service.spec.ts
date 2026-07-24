import { ChatRealtimeService } from './chat-realtime.service';

describe('ChatRealtimeService', () => {
  let service: ChatRealtimeService;
  let mockConfigService: any;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'SUPABASE_URL') return 'https://x.supabase.co';
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') return 'service-role-key';
        return undefined;
      }),
    };
    service = new ChatRealtimeService(mockConfigService);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 202 } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts a newMessage broadcast to the event topic', async () => {
    service.broadcastMessage('event-1', { id: 'msg-1', message: 'hi' });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://x.supabase.co/realtime/v1/api/broadcast',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'service-role-key', Authorization: 'Bearer service-role-key' }),
      }),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({
      topic: 'event:event-1',
      event: 'newMessage',
      payload: { id: 'msg-1', message: 'hi' },
      private: false,
    });
  });

  it('posts an announcement broadcast to the same event topic', async () => {
    service.broadcastAnnouncement('event-1', { id: 'ann-1', title: 'Heads up' });
    await Promise.resolve();
    await Promise.resolve();

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].topic).toBe('event:event-1');
    expect(body.messages[0].event).toBe('announcement');
  });

  it('skips broadcasting without throwing when Supabase env vars are unconfigured', async () => {
    mockConfigService.get.mockReturnValue(undefined);
    expect(() => service.broadcastMessage('event-1', { id: 'msg-1' })).not.toThrow();
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows a failed broadcast request instead of throwing', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    expect(() => service.broadcastMessage('event-1', { id: 'msg-1' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
