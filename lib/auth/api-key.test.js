#!/usr/bin/env node
/**
 * Unit tests for API key validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateApiKeyFormat, testApiKey, validateApiKey } from './api-key.js';

// Mock fetch for testing
global.fetch = vi.fn();

describe('API Key Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateApiKeyFormat', () => {
    it('should reject null or undefined', () => {
      expect(validateApiKeyFormat(null).valid).toBe(false);
      expect(validateApiKeyFormat(undefined).valid).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(validateApiKeyFormat(123).valid).toBe(false);
      expect(validateApiKeyFormat({}).valid).toBe(false);
    });

    it('should reject keys that are too short', () => {
      const result = validateApiKeyFormat('short');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
    });

    it('should reject keys that are too long', () => {
      const longKey = 'a'.repeat(257);
      const result = validateApiKeyFormat(longKey);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject keys with invalid characters', () => {
      const result = validateApiKeyFormat('invalid@key#123');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should accept valid API keys', () => {
      expect(validateApiKeyFormat('valid-api-key-123').valid).toBe(true);
      expect(validateApiKeyFormat('test_key.123').valid).toBe(true);
      expect(validateApiKeyFormat('a'.repeat(50)).valid).toBe(true);
    });
  });

  describe('testApiKey', () => {
    it('should return error if relay URL is missing', async () => {
      const result = await testApiKey('test-key', '');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should return valid for successful API call', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: '1.0.0' })
      });

      const result = await testApiKey('test-key', 'http://localhost:3030');
      expect(result.valid).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3030/api/version',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key'
          })
        })
      );
    });

    it('should return invalid for 401 response', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401
      });

      const result = await testApiKey('invalid-key', 'http://localhost:3030');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('should handle connection errors', async () => {
      // Mock retryFetch to throw ECONNREFUSED error directly
      const error = new Error('Connection refused');
      error.code = 'ECONNREFUSED';
      // Mock fetch to throw the error (retryFetch will catch and re-throw)
      global.fetch.mockRejectedValueOnce(error);

      const result = await testApiKey('test-key', 'http://localhost:3030');
      expect(result.valid).toBe(false);
      // The error message should contain either "Connection refused" or the error message
      expect(result.error).toMatch(/Connection refused|Failed to test API key/);
    });
  });

  describe('validateApiKey', () => {
    it('should validate format first, then test', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: '1.0.0' })
      });

      const result = await validateApiKey('valid-key-123', 'http://localhost:3030');
      expect(result.valid).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('should return format error without testing', async () => {
      const result = await validateApiKey('short', 'http://localhost:3030');
      expect(result.valid).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return valid with warning if no URL provided', async () => {
      const result = await validateApiKey('valid-key-123', '');
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
    });
  });
});

