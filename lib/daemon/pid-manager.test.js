import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  isProcessRunning,
  readPid,
  writePid,
  removePid,
  checkDaemonStatus,
  cleanupStalePid,
  acquirePidLock,
  releasePidLock,
  PID_FILE
} from './pid-manager.js';

const TEST_PID_FILE = join(homedir(), '.teleportation', 'daemon.pid');

describe('PID Manager', () => {
  beforeEach(async () => {
    // Clean up any existing PID file
    try {
      await fs.unlink(TEST_PID_FILE);
    } catch (err) {
      // Ignore if file doesn't exist
    }
  });

  afterEach(async () => {
    // Clean up after tests
    try {
      await fs.unlink(TEST_PID_FILE);
    } catch (err) {
      // Ignore if file doesn't exist
    }
  });

  describe('isProcessRunning', () => {
    it('should return true for current process', () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('should return false for non-existent process', () => {
      // Use a very high PID that's unlikely to exist
      expect(isProcessRunning(999999)).toBe(false);
    });

    it('should return false for PID 0', () => {
      expect(isProcessRunning(0)).toBe(false);
    });

    it('should return false for negative PID', () => {
      expect(isProcessRunning(-1)).toBe(false);
    });
  });

  describe('readPid', () => {
    it('should return null when PID file does not exist', async () => {
      const pid = await readPid();
      expect(pid).toBeNull();
    });

    it('should read valid PID from file', async () => {
      const testPid = 12345;
      await writePid(testPid);
      const pid = await readPid();
      expect(pid).toBe(testPid);
    });

    it('should return null for invalid PID content', async () => {
      await fs.mkdir(join(homedir(), '.teleportation'), { recursive: true });
      await fs.writeFile(TEST_PID_FILE, 'not-a-number');
      const pid = await readPid();
      expect(pid).toBeNull();
    });

    it('should return null for negative PID', async () => {
      await fs.mkdir(join(homedir(), '.teleportation'), { recursive: true });
      await fs.writeFile(TEST_PID_FILE, '-123');
      const pid = await readPid();
      expect(pid).toBeNull();
    });

    it('should return null for zero PID', async () => {
      await fs.mkdir(join(homedir(), '.teleportation'), { recursive: true });
      await fs.writeFile(TEST_PID_FILE, '0');
      const pid = await readPid();
      expect(pid).toBeNull();
    });
  });

  describe('writePid', () => {
    it('should write PID to file', async () => {
      const testPid = 54321;
      await writePid(testPid);

      const content = await fs.readFile(TEST_PID_FILE, 'utf-8');
      expect(content).toBe(String(testPid));
    });

    it('should create .teleportation directory if it does not exist', async () => {
      const teleportationDir = join(homedir(), '.teleportation');

      // Remove directory if it exists
      try {
        await fs.rm(teleportationDir, { recursive: true });
      } catch (err) {
        // Ignore if doesn't exist
      }

      await writePid(12345);

      const stat = await fs.stat(teleportationDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should set PID file permissions to 600', async () => {
      await writePid(12345);

      const stat = await fs.stat(TEST_PID_FILE);
      // Mode is in octal, check if it's 0o600 (owner read/write only)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('removePid', () => {
    it('should remove PID file', async () => {
      await writePid(12345);
      await removePid();

      await expect(fs.access(TEST_PID_FILE)).rejects.toThrow();
    });

    it('should not throw when PID file does not exist', async () => {
      await expect(removePid()).resolves.not.toThrow();
    });
  });

  describe('checkDaemonStatus', () => {
    it('should return not running when no PID file exists', async () => {
      const status = await checkDaemonStatus();
      expect(status).toEqual({
        running: false,
        pid: null,
        stale: false
      });
    });

    it('should return running true when PID file contains current process', async () => {
      await writePid(process.pid);

      const status = await checkDaemonStatus();
      expect(status).toEqual({
        running: true,
        pid: process.pid,
        stale: false
      });
    });

    it('should return stale true when PID file contains dead process', async () => {
      const deadPid = 999999;
      await writePid(deadPid);

      const status = await checkDaemonStatus();
      expect(status).toEqual({
        running: false,
        pid: deadPid,
        stale: true
      });
    });
  });

  describe('cleanupStalePid', () => {
    it('should remove stale PID file', async () => {
      const deadPid = 999999;
      await writePid(deadPid);

      const cleaned = await cleanupStalePid();
      expect(cleaned).toBe(true);

      const status = await checkDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
    });

    it('should not remove PID file if process is running', async () => {
      await writePid(process.pid);

      const cleaned = await cleanupStalePid();
      expect(cleaned).toBe(false);

      const pid = await readPid();
      expect(pid).toBe(process.pid);
    });

    it('should return false when no PID file exists', async () => {
      const cleaned = await cleanupStalePid();
      expect(cleaned).toBe(false);
    });
  });

  describe('acquirePidLock', () => {
    it('should acquire lock when no daemon is running', async () => {
      await expect(acquirePidLock(process.pid)).resolves.not.toThrow();

      const pid = await readPid();
      expect(pid).toBe(process.pid);
    });

    it('should throw when another daemon is running', async () => {
      await writePid(process.pid);

      // Try to acquire lock with different PID
      await expect(acquirePidLock(process.pid + 1)).rejects.toThrow(
        /Daemon already running/
      );
    });

    it('should clean up stale PID and acquire lock', async () => {
      const deadPid = 999999;
      await writePid(deadPid);

      await expect(acquirePidLock(process.pid)).resolves.not.toThrow();

      const pid = await readPid();
      expect(pid).toBe(process.pid);
    });
  });

  describe('releasePidLock', () => {
    it('should release lock when PID matches', async () => {
      await writePid(process.pid);
      await releasePidLock(process.pid);

      const pid = await readPid();
      expect(pid).toBeNull();
    });

    it('should not release lock when PID does not match', async () => {
      const otherPid = process.pid + 1;
      await writePid(otherPid);
      await releasePidLock(process.pid);

      const pid = await readPid();
      expect(pid).toBe(otherPid);
    });

    it('should not throw when no PID file exists', async () => {
      await expect(releasePidLock(process.pid)).resolves.not.toThrow();
    });
  });
});
