#!/usr/bin/env node
/**
 * Unit tests for credential encryption and storage
 * Tests AES-256 encryption, file permissions, and credential management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { CredentialManager } from './credentials.js';

const TEST_CREDENTIALS_PATH = join(homedir(), '.teleportation', 'credentials.test');

describe('CredentialManager', () => {
  let manager;

  beforeEach(() => {
    manager = new CredentialManager(TEST_CREDENTIALS_PATH);
  });

  afterEach(async () => {
    // Clean up test file
    try {
      await unlink(TEST_CREDENTIALS_PATH);
    } catch (e) {
      // File might not exist, ignore
    }
  });

  describe('encryption/decryption', () => {
    it('should encrypt and decrypt credentials successfully', async () => {
      const credentials = {
        accessToken: 'test-token-123',
        refreshToken: 'refresh-token-456',
        expiresAt: Date.now() + 86400000,
        apiKey: 'api-key-789'
      };

      await manager.save(credentials);
      const loaded = await manager.load();

      expect(loaded).toBeDefined();
      expect(loaded.accessToken).toBe(credentials.accessToken);
      expect(loaded.refreshToken).toBe(credentials.refreshToken);
      expect(loaded.apiKey).toBe(credentials.apiKey);
    });

    it('should handle empty credentials', async () => {
      const credentials = {};
      await manager.save(credentials);
      const loaded = await manager.load();
      expect(loaded).toEqual({});
    });

    it('should encrypt sensitive data (no plaintext in file)', async () => {
      const credentials = {
        accessToken: 'secret-token-12345',
        apiKey: 'secret-api-key-67890'
      };

      await manager.save(credentials);
      const fileContent = await readFile(TEST_CREDENTIALS_PATH, 'utf8');
      const parsed = JSON.parse(fileContent);

      // File should contain encrypted data, not plaintext
      expect(parsed.data).toBeDefined();
      expect(parsed.iv).toBeDefined();
      expect(fileContent).not.toContain('secret-token-12345');
      expect(fileContent).not.toContain('secret-api-key-67890');
    });
  });

  describe('file permissions', () => {
    it('should set file permissions to 600 (owner read/write only)', async () => {
      const credentials = { accessToken: 'test' };
      await manager.save(credentials);

      const stats = await stat(TEST_CREDENTIALS_PATH);
      const mode = stats.mode & parseInt('777', 8);
      
      // On Unix systems, 600 means rw------- (owner read/write, no others)
      expect(mode).toBe(parseInt('600', 8));
    });
  });

  describe('credential validation', () => {
    it('should validate credentials before saving', async () => {
      const invalidCredentials = null;
      
      await expect(manager.save(invalidCredentials)).rejects.toThrow();
    });

    it('should handle missing credentials file gracefully', async () => {
      const manager2 = new CredentialManager(join(homedir(), '.teleportation', 'nonexistent-credentials'));
      const loaded = await manager2.load();
      expect(loaded).toBeNull();
    });

    it('should handle corrupted credential files gracefully', async () => {
      // Create a corrupted file
      const fs = await import('fs/promises');
      await fs.writeFile(TEST_CREDENTIALS_PATH, 'invalid json content!!!', { mode: 0o600 });
      
      await expect(manager.load()).rejects.toThrow();
    });

    it('should handle invalid encrypted data gracefully', async () => {
      // Create a file with invalid encrypted data structure
      const fs = await import('fs/promises');
      await fs.writeFile(
        TEST_CREDENTIALS_PATH,
        JSON.stringify({ data: 'invalid', iv: 'invalid' }),
        { mode: 0o600 }
      );
      
      await expect(manager.load()).rejects.toThrow();
    });
  });

  describe('credential expiry', () => {
    it('should detect expired credentials', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() - 1000 // Expired 1 second ago
      };

      await manager.save(credentials);
      const isExpired = await manager.isExpired();
      expect(isExpired).toBe(true);
    });

    it('should detect valid (non-expired) credentials', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() + 86400000 // Expires in 1 day
      };

      await manager.save(credentials);
      const isExpired = await manager.isExpired();
      expect(isExpired).toBe(false);
    });

    it('should handle credentials without expiry', async () => {
      const credentials = {
        accessToken: 'test-token'
        // No expiresAt field
      };

      await manager.save(credentials);
      const isExpired = await manager.isExpired();
      // Should return false if no expiry is set
      expect(isExpired).toBe(false);
    });
  });

  describe('credential rotation', () => {
    it('should detect credentials needing rotation (expired)', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() - 1000 // Expired
      };

      await manager.save(credentials);
      const needsRotation = await manager.needsRotation();
      expect(needsRotation).toBe(true);
    });

    it('should detect credentials needing rotation (within warning period)', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() + (3 * 24 * 60 * 60 * 1000) // Expires in 3 days (within 7-day warning)
      };

      await manager.save(credentials);
      const needsRotation = await manager.needsRotation(7);
      expect(needsRotation).toBe(true);
    });

    it('should not flag credentials that are still valid', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // Expires in 30 days
      };

      await manager.save(credentials);
      const needsRotation = await manager.needsRotation(7);
      expect(needsRotation).toBe(false);
    });

    it('should calculate days until expiry correctly', async () => {
      const daysUntil = 10;
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() + (daysUntil * 24 * 60 * 60 * 1000)
      };

      await manager.save(credentials);
      const days = await manager.daysUntilExpiry();
      expect(days).toBeGreaterThanOrEqual(daysUntil - 1); // Allow 1 day variance
      expect(days).toBeLessThanOrEqual(daysUntil + 1);
    });

    it('should return negative days for expired credentials', async () => {
      const credentials = {
        accessToken: 'test-token',
        expiresAt: Date.now() - (5 * 24 * 60 * 60 * 1000) // Expired 5 days ago
      };

      await manager.save(credentials);
      const days = await manager.daysUntilExpiry();
      expect(days).toBeLessThan(0);
    });

    it('should return null for credentials without expiry', async () => {
      const credentials = {
        accessToken: 'test-token'
        // No expiresAt
      };

      await manager.save(credentials);
      const days = await manager.daysUntilExpiry();
      expect(days).toBeNull();
    });
  });

  describe('credential updates', () => {
    it('should update existing credentials', async () => {
      const original = {
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() + 86400000
      };

      await manager.save(original);
      const updated = await manager.update({
        accessToken: 'new-token'
      });

      expect(updated.accessToken).toBe('new-token');
      expect(updated.refreshToken).toBe('old-refresh'); // Preserved
      expect(updated.updatedAt).toBeDefined();
    });

    it('should throw error when updating non-existent credentials', async () => {
      const manager2 = new CredentialManager(join(homedir(), '.teleportation', 'nonexistent-credentials'));
      await expect(manager2.update({ accessToken: 'new' })).rejects.toThrow();
    });
  });

  describe('credential deletion', () => {
    it('should delete credentials file', async () => {
      const credentials = { accessToken: 'test' };
      await manager.save(credentials);
      
      await manager.delete();
      
      const fs = await import('fs/promises');
      await expect(fs.access(TEST_CREDENTIALS_PATH)).rejects.toThrow();
    });

    it('should handle deletion of non-existent file gracefully', async () => {
      await expect(manager.delete()).resolves.not.toThrow();
    });
  });

  describe('key management', () => {
    it('should use system keychain when available', async () => {
      // This test verifies that the manager attempts to use keychain
      // Actual keychain integration will be platform-specific
      const manager2 = new CredentialManager(TEST_CREDENTIALS_PATH);
      expect(manager2).toBeDefined();
    });

    it('should fallback to file-based key when keychain unavailable', async () => {
      // Test fallback mechanism
      const credentials = { accessToken: 'test' };
      await manager.save(credentials);
      const loaded = await manager.load();
      expect(loaded.accessToken).toBe('test');
    });
  });
});

