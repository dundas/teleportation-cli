/**
 * Tests for logger utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger, LOG_LEVELS } from './logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock fs methods
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn()
  }
}));

describe('Logger', () => {
  let logger;
  const mockLogFile = path.join(os.tmpdir(), 'test.log');

  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
    logger = new Logger({
      level: LOG_LEVELS.DEBUG,
      logFile: mockLogFile,
      enableFileLogging: true,
      enableColors: false
    });
  });

  describe('constructor', () => {
    it('should create logger with default options', () => {
      const defaultLogger = new Logger();
      expect(defaultLogger.level).toBe(LOG_LEVELS.INFO);
      expect(defaultLogger.enableFileLogging).toBe(true);
    });

    it('should create logger with custom options', () => {
      const customLogger = new Logger({
        level: LOG_LEVELS.WARN,
        enableFileLogging: false
      });
      expect(customLogger.level).toBe(LOG_LEVELS.WARN);
      expect(customLogger.enableFileLogging).toBe(false);
    });

    it('should create log directory if it does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      new Logger({ logFile: mockLogFile });
      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('log levels', () => {
    it('should log DEBUG messages when level is DEBUG', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.setLevel(LOG_LEVELS.DEBUG);
      logger.debug('test message');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should not log DEBUG messages when level is INFO', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.setLevel(LOG_LEVELS.INFO);
      logger.debug('test message');
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should log ERROR messages to stderr', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logger.error('test error');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('file logging', () => {
    it('should write to log file when enabled', () => {
      logger.info('test message');
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        mockLogFile,
        expect.stringContaining('[INFO] test message'),
        { flag: 'a' }
      );
    });

    it('should not write to log file when disabled', () => {
      const noFileLogger = new Logger({
        enableFileLogging: false
      });
      noFileLogger.info('test message');
      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('convenience methods', () => {
    it('should provide success method', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.success('Operation succeeded');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should provide failure method', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logger.failure('Operation failed');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('setLevel', () => {
    it('should set level by number', () => {
      logger.setLevel(LOG_LEVELS.WARN);
      expect(logger.level).toBe(LOG_LEVELS.WARN);
    });

    it('should set level by string', () => {
      logger.setLevel('WARN');
      expect(logger.level).toBe(LOG_LEVELS.WARN);
    });

    it('should default to INFO for invalid string', () => {
      logger.setLevel('INVALID');
      expect(logger.level).toBe(LOG_LEVELS.INFO);
    });
  });
});

