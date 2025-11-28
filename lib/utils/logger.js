#!/usr/bin/env node
/**
 * Structured logging utility for Teleportation CLI
 * Supports different log levels and output formats
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

const LOG_LEVEL_NAMES = {
  0: 'DEBUG',
  1: 'INFO',
  2: 'WARN',
  3: 'ERROR',
  4: 'NONE'
};

class Logger {
  constructor(options = {}) {
    this.level = options.level || (process.env.DEBUG ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO);
    this.logFile = options.logFile || path.join(os.homedir(), '.teleportation', 'logs', 'cli.log');
    this.enableFileLogging = options.enableFileLogging !== false;
    this.enableColors = options.enableColors !== false && process.stdout.isTTY;
    
    // Ensure log directory exists
    if (this.enableFileLogging) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
  }

  _colorize(level, message) {
    if (!this.enableColors) return message;
    
    const colors = {
      DEBUG: '\x1b[0;36m', // Cyan
      INFO: '\x1b[0;32m',  // Green
      WARN: '\x1b[1;33m',  // Yellow
      ERROR: '\x1b[0;31m'  // Red
    };
    const reset = '\x1b[0m';
    
    return `${colors[level] || ''}${message}${reset}`;
  }

  _formatMessage(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const levelName = LOG_LEVEL_NAMES[level];
    const prefix = `[${timestamp}] [${levelName}]`;
    
    let formatted = `${prefix} ${message}`;
    if (data) {
      formatted += ` ${JSON.stringify(data)}`;
    }
    
    return formatted;
  }

  _write(level, message, data = null) {
    if (level < this.level) {
      return;
    }

    const formatted = this._formatMessage(level, message, data);
    const levelName = LOG_LEVEL_NAMES[level];
    
    // Console output (with colors)
    const consoleMessage = this._colorize(levelName, formatted);
    if (level >= LOG_LEVELS.ERROR) {
      console.error(consoleMessage);
    } else {
      console.log(consoleMessage);
    }

    // File output (without colors)
    if (this.enableFileLogging) {
      try {
        fs.appendFileSync(this.logFile, formatted + '\n', { flag: 'a' });
      } catch (e) {
        // Silently fail if log file can't be written
      }
    }
  }

  debug(message, data) {
    this._write(LOG_LEVELS.DEBUG, message, data);
  }

  info(message, data) {
    this._write(LOG_LEVELS.INFO, message, data);
  }

  warn(message, data) {
    this._write(LOG_LEVELS.WARN, message, data);
  }

  error(message, data) {
    this._write(LOG_LEVELS.ERROR, message, data);
  }

  // Convenience methods for common patterns
  success(message) {
    if (this.enableColors) {
      console.log(`\x1b[0;32m✓\x1b[0m ${message}`);
    } else {
      console.log(`✓ ${message}`);
    }
  }

  failure(message) {
    if (this.enableColors) {
      console.error(`\x1b[0;31m✗\x1b[0m ${message}`);
    } else {
      console.error(`✗ ${message}`);
    }
  }

  // Get log file path
  getLogFile() {
    return this.logFile;
  }

  // Set log level
  setLevel(level) {
    if (typeof level === 'string') {
      level = LOG_LEVELS[level.toUpperCase()] || LOG_LEVELS.INFO;
    }
    this.level = level;
  }
}

// Create default logger instance
const logger = new Logger();

export default logger;
export { Logger, LOG_LEVELS };

