/**
 * Tests for error utilities
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TeleportationError,
  ConfigurationError,
  AuthenticationError,
  NetworkError,
  ValidationError,
  FileSystemError,
  formatError,
  getUserFriendlyMessage,
  handleError
} from './errors.js';

describe('Error classes', () => {
  describe('TeleportationError', () => {
    it('should create error with message and code', () => {
      const error = new TeleportationError('Test error', 'TEST_CODE');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('TeleportationError');
    });

    it('should include details', () => {
      const details = { field: 'value' };
      const error = new TeleportationError('Test error', 'TEST_CODE', details);
      expect(error.details).toEqual(details);
    });

    it('should serialize to JSON', () => {
      const error = new TeleportationError('Test error', 'TEST_CODE', { test: true });
      const json = error.toJSON();
      expect(json).toEqual({
        name: 'TeleportationError',
        message: 'Test error',
        code: 'TEST_CODE',
        details: { test: true }
      });
    });
  });

  describe('ConfigurationError', () => {
    it('should create configuration error', () => {
      const error = new ConfigurationError('Config invalid');
      expect(error.message).toBe('Config invalid');
      expect(error.code).toBe('CONFIG_ERROR');
      expect(error.name).toBe('ConfigurationError');
    });
  });

  describe('AuthenticationError', () => {
    it('should create authentication error', () => {
      const error = new AuthenticationError('Auth failed');
      expect(error.message).toBe('Auth failed');
      expect(error.code).toBe('AUTH_ERROR');
      expect(error.name).toBe('AuthenticationError');
    });
  });

  describe('NetworkError', () => {
    it('should create network error', () => {
      const error = new NetworkError('Connection failed');
      expect(error.message).toBe('Connection failed');
      expect(error.code).toBe('NETWORK_ERROR');
      expect(error.name).toBe('NetworkError');
    });
  });

  describe('ValidationError', () => {
    it('should create validation error', () => {
      const error = new ValidationError('Invalid input');
      expect(error.message).toBe('Invalid input');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('FileSystemError', () => {
    it('should create filesystem error', () => {
      const error = new FileSystemError('File not found');
      expect(error.message).toBe('File not found');
      expect(error.code).toBe('FILESYSTEM_ERROR');
      expect(error.name).toBe('FileSystemError');
    });
  });
});

describe('formatError', () => {
  it('should format TeleportationError', () => {
    const error = new ConfigurationError('Config invalid');
    const formatted = formatError(error);
    expect(formatted.code).toBe('CONFIG_ERROR');
    expect(formatted.message).toBe('Config invalid');
    expect(formatted.userFriendly).toContain('Configuration error');
  });

  it('should format standard Error', () => {
    const error = new Error('Standard error');
    const formatted = formatError(error);
    expect(formatted.code).toBe('UNKNOWN_ERROR');
    expect(formatted.message).toBe('Standard error');
  });

  it('should handle errors with code property', () => {
    const error = new Error('File not found');
    error.code = 'ENOENT';
    const formatted = formatError(error);
    expect(formatted.userFriendly).toContain('File not found');
  });
});

describe('getUserFriendlyMessage', () => {
  it('should provide friendly message for ConfigurationError', () => {
    const error = new ConfigurationError('Invalid config');
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Configuration error');
    expect(message).toContain('teleportation config list');
  });

  it('should provide friendly message for AuthenticationError', () => {
    const error = new AuthenticationError('Invalid credentials');
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Authentication failed');
    expect(message).toContain('teleportation login');
  });

  it('should provide friendly message for NetworkError', () => {
    const error = new NetworkError('Connection timeout');
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Network error');
    expect(message).toContain('internet connection');
  });

  it('should handle ENOENT error code', () => {
    const error = new Error('File not found');
    error.code = 'ENOENT';
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('File not found');
  });

  it('should handle EACCES error code', () => {
    const error = new Error('Permission denied');
    error.code = 'EACCES';
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Permission denied');
  });

  it('should handle ECONNREFUSED error code', () => {
    const error = new Error('Connection refused');
    error.code = 'ECONNREFUSED';
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Connection refused');
  });

  it('should handle ETIMEDOUT error code', () => {
    const error = new Error('Connection timeout');
    error.code = 'ETIMEDOUT';
    const message = getUserFriendlyMessage(error);
    expect(message).toContain('Connection timeout');
  });

  it('should provide default message for unknown errors', () => {
    const error = new Error('Unknown error');
    const message = getUserFriendlyMessage(error);
    expect(message).toBe('Unknown error');
  });
});

describe('handleError', () => {
  it('should exit with code 2 for CONFIG_ERROR', () => {
    const error = new ConfigurationError('Config error');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    handleError(error);
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it('should exit with code 3 for AUTH_ERROR', () => {
    const error = new AuthenticationError('Auth error');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    handleError(error);
    expect(exitSpy).toHaveBeenCalledWith(3);
    exitSpy.mockRestore();
  });

  it('should exit with code 1 for unknown errors', () => {
    const error = new Error('Unknown error');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    handleError(error);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

