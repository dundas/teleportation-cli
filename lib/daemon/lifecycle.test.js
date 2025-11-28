import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  getDaemonStatus,
  startDaemonIfNeeded,
  stopDaemonIfNeeded
} from './lifecycle.js';
import {
  readPid,
  writePid,
  removePid
} from './pid-manager.js';
import * as pidManager from './pid-manager.js';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

describe('Lifecycle Management', () => {
  let originalProcessKill;
  let originalFetch;

  beforeEach(async () => {
    // Clean up any existing PID file
    await removePid();
    vi.clearAllMocks();

    // Save originals
    originalProcessKill = process.kill;
    originalFetch = global.fetch;
  });

  afterEach(async () => {
    // Clean up after tests
    await removePid();

    // Restore process.kill
    process.kill = originalProcessKill;

    // Restore fetch
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  describe('startDaemon', () => {
    it('should start daemon when not running', async () => {
      // Mock spawn to return a fake process
      const mockChild = {
        pid: 12345,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      // Mock checkDaemonStatus to indicate daemon not running, then running
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: null, stale: false }) // Initial check
        .mockResolvedValueOnce({ running: true, pid: 12345, stale: false }); // After start

      const result = await startDaemon();

      expect(result.success).toBe(true);
      expect(result.pid).toBe(12345);
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          env: expect.objectContaining({
            TELEPORTATION_DAEMON: 'true'
          })
        })
      );
      expect(mockChild.unref).toHaveBeenCalled();

      checkStatusSpy.mockRestore();
    });

    it('should throw if daemon is already running', async () => {
      // Mock checkDaemonStatus to indicate daemon is running
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: true, pid: 99999, stale: false });

      await expect(startDaemon()).rejects.toThrow(/already running/);

      checkStatusSpy.mockRestore();
    });

    it('should clean up stale PID file before starting', async () => {
      const mockChild = {
        pid: 12345,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      // Mock checkDaemonStatus to indicate stale PID
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: 99999, stale: true }) // Initial check (stale)
        .mockResolvedValueOnce({ running: true, pid: 12345, stale: false }); // After start

      const result = await startDaemon();

      expect(result.success).toBe(true);

      checkStatusSpy.mockRestore();
    });

    it('should pass detached and silent options', async () => {
      const mockChild = {
        pid: 12345,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: null, stale: false })
        .mockResolvedValueOnce({ running: true, pid: 12345, stale: false });

      await startDaemon({ detached: false, silent: false });

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.any(Array),
        expect.objectContaining({
          detached: false,
          stdio: 'inherit'
        })
      );
      expect(mockChild.unref).not.toHaveBeenCalled();

      checkStatusSpy.mockRestore();
    });

    it('should throw if daemon fails to start', async () => {
      const mockChild = {
        pid: 12345,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      // Mock checkDaemonStatus to indicate daemon not running after spawn
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: null, stale: false })
        .mockResolvedValueOnce({ running: false, pid: null, stale: false });

      await expect(startDaemon()).rejects.toThrow(/failed to start/);

      checkStatusSpy.mockRestore();
    });
  });

  describe('stopDaemon', () => {
    it('should return success if daemon is not running', async () => {
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: false, pid: null, stale: false });

      const result = await stopDaemon();

      expect(result.success).toBe(true);
      expect(result.forced).toBe(false);

      checkStatusSpy.mockRestore();
    });

    it('should send SIGTERM and wait for process to exit', async () => {
      const testPid = 99999;

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: true, pid: testPid, stale: false });

      const isRunningspy = vi.spyOn(pidManager, 'isProcessRunning');
      isRunningspy.mockReturnValue(false); // Process exits immediately

      // Mock process.kill to not actually send signals
      const killCalls = [];
      process.kill = vi.fn((pid, signal) => {
        killCalls.push({ pid, signal });
      });

      const result = await stopDaemon({ timeout: 1000 });

      expect(killCalls).toContainEqual({ pid: testPid, signal: 'SIGTERM' });
      expect(result.success).toBe(true);
      expect(result.forced).toBe(false);

      checkStatusSpy.mockRestore();
      isRunningspy.mockRestore();
    });

    it('should force kill if timeout is reached', async () => {
      const testPid = 99998;

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: true, pid: testPid, stale: false });

      const isRunningspy = vi.spyOn(pidManager, 'isProcessRunning');

      // Track if SIGKILL has been sent
      let sigkillSent = false;
      const killCalls = [];
      process.kill = vi.fn((pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGKILL') sigkillSent = true;
      });

      // Process stays running until SIGKILL is sent
      isRunningspy.mockImplementation(() => !sigkillSent);

      const result = await stopDaemon({ timeout: 100, force: true });

      expect(killCalls).toContainEqual({ pid: testPid, signal: 'SIGTERM' });
      expect(killCalls).toContainEqual({ pid: testPid, signal: 'SIGKILL' });
      expect(result.success).toBe(true);
      expect(result.forced).toBe(true);

      checkStatusSpy.mockRestore();
      isRunningspy.mockRestore();
    });

    it('should not force kill if force option is false', async () => {
      const testPid = 99997;

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: true, pid: testPid, stale: false });

      const isRunningspy = vi.spyOn(pidManager, 'isProcessRunning');
      isRunningspy.mockReturnValue(true); // Process never exits

      const killCalls = [];
      process.kill = vi.fn((pid, signal) => {
        killCalls.push({ pid, signal });
      });

      const result = await stopDaemon({ timeout: 100, force: false });

      expect(killCalls).toContainEqual({ pid: testPid, signal: 'SIGTERM' });
      expect(killCalls).not.toContainEqual({ pid: testPid, signal: 'SIGKILL' });
      expect(result.success).toBe(false);
      expect(result.forced).toBe(false);

      checkStatusSpy.mockRestore();
      isRunningspy.mockRestore();
    });
  });

  describe('restartDaemon', () => {
    it('should stop and start daemon if running', async () => {
      const mockChild = {
        pid: 54321,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: true, pid: 99999, stale: false }) // Initial check in restartDaemon (running)
        .mockResolvedValueOnce({ running: true, pid: 99999, stale: false }) // stopDaemon initial check
        .mockResolvedValueOnce({ running: false, pid: null, stale: false }) // startDaemon initial check (after stop)
        .mockResolvedValueOnce({ running: true, pid: 54321, stale: false }); // startDaemon verification

      const isRunningspy = vi.spyOn(pidManager, 'isProcessRunning');
      isRunningspy.mockReturnValue(false); // Process exits immediately on SIGTERM

      process.kill = vi.fn();

      const result = await restartDaemon();

      expect(result.success).toBe(true);
      expect(result.wasRunning).toBe(true);
      expect(result.pid).toBe(54321);

      checkStatusSpy.mockRestore();
      isRunningspy.mockRestore();
    });

    it('should start daemon if not running', async () => {
      const mockChild = {
        pid: 54321,
        unref: vi.fn()
      };
      spawn.mockReturnValue(mockChild);

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: null, stale: false }) // Initial check in restartDaemon (not running)
        .mockResolvedValueOnce({ running: false, pid: null, stale: false }) // startDaemon initial check
        .mockResolvedValueOnce({ running: true, pid: 54321, stale: false }); // startDaemon verification

      const result = await restartDaemon();

      expect(result.success).toBe(true);
      expect(result.wasRunning).toBe(false);
      expect(result.pid).toBe(54321);

      checkStatusSpy.mockRestore();
    });
  });

  describe('getDaemonStatus', () => {
    it('should return not running when daemon is not running', async () => {
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: false, pid: null, stale: false });

      const status = await getDaemonStatus();

      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.uptime).toBeNull();

      checkStatusSpy.mockRestore();
    });

    it('should return running when daemon is running', async () => {
      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      checkStatusSpy.mockResolvedValue({ running: true, pid: 12345, stale: false });

      const status = await getDaemonStatus();

      expect(status.running).toBe(true);
      expect(status.pid).toBe(12345);

      checkStatusSpy.mockRestore();
    });
  });

  describe('startDaemonIfNeeded / stopDaemonIfNeeded', () => {
    it('startDaemonIfNeeded should start daemon when not running and update daemon_state', async () => {
      const mockChild = { pid: 12345, unref: vi.fn() };
      spawn.mockReturnValue(mockChild);

      const checkStatusSpy = vi.spyOn(pidManager, 'checkDaemonStatus');
      // 1) startDaemonIfNeeded initial check
      // 2) startDaemon initial check
      // 3) startDaemon verification after spawn
      checkStatusSpy
        .mockResolvedValueOnce({ running: false, pid: null, stale: false })
        .mockResolvedValueOnce({ running: false, pid: null, stale: false })
        .mockResolvedValueOnce({ running: true, pid: 12345, stale: false });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock;

      process.env.RELAY_API_URL = 'http://relay.test';
      process.env.RELAY_API_KEY = 'key';

      await startDaemonIfNeeded('sess-1', 'timeout');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://relay.test/api/sessions/sess-1/daemon-state');
      const body = JSON.parse(options.body);
      expect(body).toMatchObject({ status: 'running', started_reason: 'timeout' });

      checkStatusSpy.mockRestore();
    });

    it('startDaemonIfNeeded should not start daemon if already running but still update state', async () => {
      const checkStatusSpy = vi
        .spyOn(pidManager, 'checkDaemonStatus')
        .mockResolvedValue({ running: true, pid: 999, stale: false });

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock;

      process.env.RELAY_API_URL = 'http://relay.test';
      process.env.RELAY_API_KEY = 'key';

      await startDaemonIfNeeded('sess-2', 'mobile_approval');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://relay.test/api/sessions/sess-2/daemon-state');
      const body = JSON.parse(options.body);
      expect(body).toMatchObject({ status: 'running', started_reason: 'mobile_approval' });

      checkStatusSpy.mockRestore();
    });

    it('stopDaemonIfNeeded should early-return when daemon is not running', async () => {
      const checkStatusSpy = vi
        .spyOn(pidManager, 'checkDaemonStatus')
        .mockResolvedValue({ running: false, pid: null, stale: false });

      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      process.env.RELAY_API_URL = 'http://relay.test';
      process.env.RELAY_API_KEY = 'key';

      const result = await stopDaemonIfNeeded('sess-3', 'session_end');

      expect(result.stopped).toBe(false);
      expect(result.reason).toBe('not_running');
      expect(fetchMock).not.toHaveBeenCalled();

      checkStatusSpy.mockRestore();
    });

    it('stopDaemonIfNeeded should stop daemon and update daemon_state when no other sessions running', async () => {
      const checkStatusSpy = vi
        .spyOn(pidManager, 'checkDaemonStatus')
        .mockResolvedValue({ running: true, pid: 111, stale: false });

      const fetchMock = vi
        .fn()
        // First call: GET /api/sessions
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [
            { session_id: 'sess-4', daemon_state: { status: 'running' } }
          ]
        })
        // Second call: PATCH /daemon-state
        .mockResolvedValueOnce({ ok: true, status: 200 });
      global.fetch = fetchMock;

      process.env.RELAY_API_URL = 'http://relay.test';
      process.env.RELAY_API_KEY = 'key';

      const result = await stopDaemonIfNeeded('sess-4', 'session_end');

      expect(result.stopped).toBe(true);
      expect(result.reason).toBe('session_end');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [url2, options2] = fetchMock.mock.calls[1];
      expect(url2).toBe('http://relay.test/api/sessions/sess-4/daemon-state');
      const body2 = JSON.parse(options2.body);
      expect(body2).toMatchObject({ status: 'stopped', is_away: false });

      checkStatusSpy.mockRestore();
    });

    it('stopDaemonIfNeeded should not stop daemon when other sessions are running', async () => {
      const checkStatusSpy = vi
        .spyOn(pidManager, 'checkDaemonStatus')
        .mockResolvedValue({ running: true, pid: 111, stale: false });

      const fetchMock = vi
        .fn()
        // First call: GET /api/sessions returns other running session
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [
            { session_id: 'other', daemon_state: { status: 'running' } }
          ]
        });
      global.fetch = fetchMock;

      process.env.RELAY_API_URL = 'http://relay.test';
      process.env.RELAY_API_KEY = 'key';

      const result = await stopDaemonIfNeeded('sess-5', 'local_approval');

      expect(result.stopped).toBe(false);
      expect(result.reason).toBe('other_sessions_running');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      checkStatusSpy.mockRestore();
    });
  });
});
