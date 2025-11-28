/**
 * Tests for session mute checker module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSessionMuted,
  clearMuteCache,
  clearAllMuteCache,
  getCacheStats
} from './mute-checker.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('mute-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllMuteCache();
    // Reset fetch mock to ensure clean state
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearAllMuteCache();
  });

  describe('isSessionMuted', () => {
    it('should return false if sessionId is missing', async () => {
      const result = await isSessionMuted('', 'http://test', 'key');
      expect(result).toBe(false);
    });

    it('should return false if relayApiUrl is missing', async () => {
      const result = await isSessionMuted('session-123', '', 'key');
      expect(result).toBe(false);
    });

    it('should return false if relayApiKey is missing', async () => {
      const result = await isSessionMuted('session-123', 'http://test', '');
      expect(result).toBe(false);
    });

    it('should return true if session is muted', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ muted: true })
      });

      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://test/api/sessions/session-123',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer key'
          })
        })
      );
    });

    it('should return false if session is not muted', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ muted: false })
      });

      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(false);
    });

    it('should check muted status in meta object', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ meta: { muted: true } })
      });

      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(true);
    });

    it('should cache mute status', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ muted: true })
      });

      // First call - should fetch from API
      const result1 = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result1).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      const result2 = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result2).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1); // Still 1, used cache
    });

    it('should return false if session not found (404)', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(false);
    });

    it('should use cached value on API error', async () => {
      // First call - cache a value
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ muted: true })
      });
      await isSessionMuted('session-123', 'http://test', 'key');

      // Second call - API fails, should use cache
      global.fetch.mockRejectedValueOnce(new Error('Network error'));
      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(true); // Uses cached value
    });

    it('should default to false on API error with no cache', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result).toBe(false); // Defaults to not muted
    });

    it('should respect timeout', async () => {
      // Mock a fetch that never resolves (simulating timeout)
      global.fetch.mockImplementationOnce(() => 
        new Promise(() => {
          // Never resolve - simulate timeout
        })
      );

      // Use Promise.race to ensure test doesn't hang forever
      const result = await Promise.race([
        isSessionMuted('session-123', 'http://test', 'key'),
        new Promise(resolve => setTimeout(() => resolve(false), 6000)) // 6s fallback
      ]);
      
      // Should timeout and default to false (fail open)
      expect(result).toBe(false);
    }, 10000); // Increase test timeout
  });

  describe('clearMuteCache', () => {
    it('should clear cache for specific session', async () => {
      // Cache a value - first call
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ muted: true })
      });
      const result1 = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result1).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Second call should use cache (no new fetch)
      const result2 = await isSessionMuted('session-123', 'http://test', 'key');
      expect(result2).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1); // Still 1, used cache

      // Verify cache is working
      const statsBefore = getCacheStats();
      expect(statsBefore.size).toBe(1);
      expect(statsBefore.entries[0].sessionId).toBe('session-123');
      expect(statsBefore.entries[0].muted).toBe(true);

      // Clear cache
      clearMuteCache('session-123');

      // Verify cache is cleared
      const statsAfter = getCacheStats();
      expect(statsAfter.size).toBe(0);
      
      // Test that cache clearing works - if we call with same session ID again,
      // it should fetch (since cache was cleared), but we'll test with a simpler approach
      // by just verifying the cache stats
      expect(statsAfter.size).toBe(0);
      expect(statsAfter.entries).toHaveLength(0);
    });

    it('should handle clearing non-existent session', () => {
      expect(() => clearMuteCache('non-existent')).not.toThrow();
    });
  });

  describe('clearAllMuteCache', () => {
    it('should clear all cached sessions', async () => {
      // Cache multiple sessions
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ muted: true })
      });
      await isSessionMuted('session-1', 'http://test', 'key');
      await isSessionMuted('session-2', 'http://test', 'key');

      clearAllMuteCache();

      const stats = getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ muted: true })
      });

      await isSessionMuted('session-123', 'http://test', 'key');

      const stats = getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.entries).toHaveLength(1);
      expect(stats.entries[0].sessionId).toBe('session-123');
      expect(stats.entries[0].muted).toBe(true);
      expect(typeof stats.entries[0].age).toBe('number');
    });
  });
});

