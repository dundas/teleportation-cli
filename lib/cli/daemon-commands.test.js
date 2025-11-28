import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { commandAway, commandBack, commandDaemonStatus } from './daemon-commands.js';

// Mock modules
vi.mock('../daemon/pid-manager.js', () => ({
  checkDaemonStatus: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

describe('Daemon Commands', () => {
  let originalEnv;
  let fetchMock;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.RELAY_API_URL = 'http://localhost:3030';
    process.env.RELAY_API_KEY = 'test-key';
    process.env.TELEPORTATION_SESSION_ID = 'test-session';

    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('commandAway', () => {
    it('should update session daemon state and start daemon', async () => {
      const { checkDaemonStatus, startDaemon } = await import('../daemon/pid-manager.js');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: false,
        pid: null,
        uptime: 0,
      });

      vi.mocked(startDaemon).mockResolvedValueOnce({
        success: true,
        pid: 12345,
      });

      await commandAway();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/test-session/daemon-state'),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
          }),
          body: expect.stringContaining('"is_away":true'),
        })
      );

      expect(vi.mocked(startDaemon)).toHaveBeenCalled();
    });

    it('should handle missing session ID', async () => {
      delete process.env.TELEPORTATION_SESSION_ID;

      await expect(commandAway()).rejects.toThrow();
    });

    it('should handle daemon already running', async () => {
      const { checkDaemonStatus } = await import('../daemon/pid-manager.js');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: true,
        pid: 12345,
        uptime: 3600,
      });

      await commandAway();

      expect(vi.mocked(checkDaemonStatus)).toHaveBeenCalled();
    });
  });

  describe('commandBack', () => {
    it('should update session daemon state and stop daemon', async () => {
      const { checkDaemonStatus, stopDaemon } = await import('../daemon/pid-manager.js');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            session_id: 'test-session',
            daemon_state: { status: 'running' },
          },
        ],
      });

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: true,
        pid: 12345,
        uptime: 3600,
      });

      vi.mocked(stopDaemon).mockResolvedValueOnce({
        success: true,
      });

      await commandBack();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/test-session/daemon-state'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"is_away":false'),
        })
      );

      expect(vi.mocked(stopDaemon)).toHaveBeenCalled();
    });

    it('should not stop daemon if other sessions running', async () => {
      const { checkDaemonStatus, stopDaemon } = await import('../daemon/pid-manager.js');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            session_id: 'test-session',
            daemon_state: { status: 'running' },
          },
          {
            session_id: 'other-session',
            daemon_state: { status: 'running' },
          },
        ],
      });

      await commandBack();

      expect(vi.mocked(stopDaemon)).not.toHaveBeenCalled();
    });

    it('should handle missing session ID', async () => {
      delete process.env.TELEPORTATION_SESSION_ID;

      await expect(commandBack()).rejects.toThrow();
    });
  });

  describe('commandDaemonStatus', () => {
    it('should display daemon status', async () => {
      const { checkDaemonStatus } = await import('../daemon/pid-manager.js');

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: true,
        pid: 12345,
        uptime: 3600,
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daemon_state: {
            status: 'running',
            started_at: Date.now(),
            started_reason: 'timeout',
            is_away: false,
            last_approval_location: 'mobile',
            stopped_reason: null,
          },
        }),
      });

      await commandDaemonStatus();

      expect(vi.mocked(checkDaemonStatus)).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/test-session'),
        expect.any(Object)
      );
    });

    it('should handle daemon not running', async () => {
      const { checkDaemonStatus } = await import('../daemon/pid-manager.js');

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: false,
        pid: null,
        uptime: 0,
      });

      await commandDaemonStatus();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Stopped'));
    });

    it('should handle missing relay API', async () => {
      const { checkDaemonStatus } = await import('../daemon/pid-manager.js');

      delete process.env.RELAY_API_URL;

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: true,
        pid: 12345,
        uptime: 3600,
      });

      await commandDaemonStatus();

      expect(vi.mocked(checkDaemonStatus)).toHaveBeenCalled();
    });
  });

  describe('formatUptime', () => {
    it('should format uptime correctly', async () => {
      // Test via commandDaemonStatus output
      const { checkDaemonStatus } = await import('../daemon/pid-manager.js');

      vi.mocked(checkDaemonStatus).mockResolvedValueOnce({
        running: true,
        pid: 12345,
        uptime: 3661, // 1h 1m 1s
      });

      await commandDaemonStatus();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1h'));
    });
  });
});
