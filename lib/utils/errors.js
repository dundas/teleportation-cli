#!/usr/bin/env node
/**
 * Custom error classes for Teleportation CLI
 * Provides structured error handling with user-friendly messages
 */

class TeleportationError extends Error {
  constructor(message, code = 'UNKNOWN_ERROR', details = null) {
    super(message);
    this.name = 'TeleportationError';
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details
    };
  }
}

class ConfigurationError extends TeleportationError {
  constructor(message, details = null) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigurationError';
  }
}

class AuthenticationError extends TeleportationError {
  constructor(message, details = null) {
    super(message, 'AUTH_ERROR', details);
    this.name = 'AuthenticationError';
  }
}

class NetworkError extends TeleportationError {
  constructor(message, details = null) {
    super(message, 'NETWORK_ERROR', details);
    this.name = 'NetworkError';
  }
}

class ValidationError extends TeleportationError {
  constructor(message, details = null) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

class FileSystemError extends TeleportationError {
  constructor(message, details = null) {
    super(message, 'FILESYSTEM_ERROR', details);
    this.name = 'FileSystemError';
  }
}

/**
 * Format error for user display
 */
function formatError(error) {
  if (error instanceof TeleportationError) {
    return {
      message: error.message,
      code: error.code,
      details: error.details,
      userFriendly: getUserFriendlyMessage(error)
    };
  }
  
  // Handle standard errors
  return {
    message: error.message,
    code: 'UNKNOWN_ERROR',
    details: null,
    userFriendly: getUserFriendlyMessage(error)
  };
}

/**
 * Get user-friendly error message
 */
function getUserFriendlyMessage(error) {
  if (error instanceof ConfigurationError) {
    return `Configuration error: ${error.message}. Please check your settings with 'teleportation config list'.`;
  }
  
  if (error instanceof AuthenticationError) {
    return `Authentication failed: ${error.message}. Please try 'teleportation login' again.`;
  }
  
  if (error instanceof NetworkError) {
    return `Network error: ${error.message}. Please check your internet connection and try again.`;
  }
  
  if (error instanceof ValidationError) {
    return `Invalid input: ${error.message}. Please check your command syntax.`;
  }
  
  if (error instanceof FileSystemError) {
    return `File system error: ${error.message}. Please check file permissions.`;
  }
  
  // Handle common system errors
  if (error.code === 'ENOENT') {
    return `File not found: ${error.message}. The file may have been moved or deleted.`;
  }
  
  if (error.code === 'EACCES') {
    return `Permission denied: ${error.message}. Please check file permissions.`;
  }
  
  if (error.code === 'ECONNREFUSED') {
    return `Connection refused: ${error.message}. The server may be down or unreachable.`;
  }
  
  if (error.code === 'ETIMEDOUT') {
    return `Connection timeout: ${error.message}. The server took too long to respond.`;
  }
  
  // Default message
  return error.message || 'An unexpected error occurred. Please try again.';
}

/**
 * Handle error and exit with appropriate code
 */
function handleError(error, logger = null) {
  const formatted = formatError(error);
  
  if (logger) {
    logger.error('Error occurred', formatted);
  } else {
    console.error(`❌ Error [${formatted.code}]: ${formatted.userFriendly}`);
    if (formatted.details && process.env.DEBUG) {
      console.error('Details:', formatted.details);
    }
  }
  
  // Exit with appropriate code
  const exitCodes = {
    'CONFIG_ERROR': 2,
    'AUTH_ERROR': 3,
    'NETWORK_ERROR': 4,
    'VALIDATION_ERROR': 5,
    'FILESYSTEM_ERROR': 6
  };
  
  process.exit(exitCodes[formatted.code] || 1);
}

export {
  TeleportationError,
  ConfigurationError,
  AuthenticationError,
  NetworkError,
  ValidationError,
  FileSystemError,
  formatError,
  getUserFriendlyMessage,
  handleError
};

