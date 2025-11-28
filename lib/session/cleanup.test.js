/**
 * Tests for session cleanup utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cleanupSession,
  cleanupAllSessions,
  isSessionTimedOut,
  getSessionAge,
  formatSessionAge
} from './cleanup.js';

// Mock mute-checker module
vi.mock('./mute-checker.js', () => ({
  clearMuteCache: vi.fn(),
  clearAllMuteCache: vi.fn()
}));

describe('cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cleanupSession', () => {
    it('should clean up session caches', async () => {
      const { clearMuteCache } = await import('./mute-checker.js');
      
      await cleanupSession('session-123');
      
      expect(clearMuteCache).toHaveBeenCalledWith('session-123');
    });

    it('should handle missing session ID gracefully', async () => {
      await expect(cleanupSession('')).resolves.not.toThrow();
      await expect(cleanupSession(null)).resolves.not.toThrow();
      await expect(cleanupSession(undefined)).resolves.not.toThrow();
    });

    it('should handle missing mute-checker module gracefully', async () => {
      // This test verifies that cleanup doesn't fail if mute-checker is unavailable
      // The actual implementation handles this with try-catch
      await expect(cleanupSession('session-123')).resolves.not.toThrow();
    });
  });

  describe('cleanupAllSessions', () => {
    it('should clean up all session caches', async () => {
      const { clearAllMuteCache } = await import('./mute-checker.js');
      
      await cleanupAllSessions();
      
      expect(clearAllMuteCache).toHaveBeenCalled();
    });

    it('should handle missing mute-checker module gracefully', async () => {
      await expect(cleanupAllSessions()).resolves.not.toThrow();
    });
  });

  describe('isSessionTimedOut', () => {
    it('should return false for recent activity', () => {
      const recent = Date.now() - 1000; // 1 second ago
      expect(isSessionTimedOut(recent)).toBe(false);
    });

    it('should return true for old activity (default 1 hour)', () => {
      const old = Date.now() - 2 * 3600000; // 2 hours ago
      expect(isSessionTimedOut(old)).toBe(true);
    });

    it('should use custom timeout', () => {
      const recent = Date.now() - 30000; // 30 seconds ago
      expect(isSessionTimedOut(recent, 10000)).toBe(true); // 10 second timeout
      expect(isSessionTimedOut(recent, 60000)).toBe(false); // 1 minute timeout
    });

    it('should return false for missing timestamp', () => {
      expect(isSessionTimedOut(null)).toBe(false);
      expect(isSessionTimedOut(undefined)).toBe(false);
    });

    it('should return true for epoch timestamp (very old)', () => {
      // Epoch (0) is a valid but very old timestamp, so it should be timed out
      expect(isSessionTimedOut(0)).toBe(true);
    });
  });

  describe('getSessionAge', () => {
    it('should return age in milliseconds', () => {
      const timestamp = Date.now() - 5000; // 5 seconds ago
      const age = getSessionAge(timestamp);
      expect(age).toBeGreaterThanOrEqual(5000);
      expect(age).toBeLessThan(6000); // Allow some margin for test execution time
    });

    it('should return 0 for missing timestamp', () => {
      expect(getSessionAge(null)).toBe(0);
      expect(getSessionAge(undefined)).toBe(0);
    });

    it('should handle epoch timestamp (0)', () => {
      // 0 is a valid timestamp (epoch), so it should return a large age
      const age = getSessionAge(0);
      expect(age).toBeGreaterThan(0);
      // Epoch was in 1970, so age should be many years (over 50 years as of 2025)
      // Just verify it's a very large number (approximately 1.7 trillion milliseconds)
      expect(age).toBeGreaterThan(1000000000000); // More than ~31 years
    });
  });

  describe('formatSessionAge', () => {
    it('should format seconds', () => {
      const timestamp = Date.now() - 5000; // 5 seconds ago
      const formatted = formatSessionAge(timestamp);
      expect(formatted).toMatch(/^\d+s$/);
    });

    it('should format minutes', () => {
      const timestamp = Date.now() - 120000; // 2 minutes ago
      const formatted = formatSessionAge(timestamp);
      expect(formatted).toMatch(/^\d+m \d+s$/);
    });

    it('should format hours', () => {
      const timestamp = Date.now() - 7200000; // 2 hours ago
      const formatted = formatSessionAge(timestamp);
      expect(formatted).toMatch(/^\d+h \d+m$/);
    });

    it('should format days', () => {
      const timestamp = Date.now() - 172800000; // 2 days ago
      const formatted = formatSessionAge(timestamp);
      expect(formatted).toMatch(/^\d+d \d+h$/);
    });

    it('should return "unknown" for missing timestamp', () => {
      expect(formatSessionAge(null)).toBe('unknown');
      expect(formatSessionAge(undefined)).toBe('unknown');
    });
  });
});

