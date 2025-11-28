#!/usr/bin/env node
/**
 * Retry utility for API calls and network operations
 * Provides exponential backoff and configurable retry logic
 */

/**
 * Retry options
 * @typedef {Object} RetryOptions
 * @property {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @property {number} initialDelay - Initial delay in milliseconds (default: 1000)
 * @property {number} maxDelay - Maximum delay in milliseconds (default: 10000)
 * @property {number} factor - Exponential backoff factor (default: 2)
 * @property {function} shouldRetry - Function to determine if error should be retried (default: retry on network errors)
 * @property {function} onRetry - Callback called before each retry attempt
 */

/**
 * Default retry options
 */
const DEFAULT_OPTIONS = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  factor: 2,
  shouldRetry: (error) => {
    // Retry on network errors, timeouts, and 5xx server errors
    if (error.name === 'AbortError' || error.name === 'TypeError') {
      return true; // Network/timeout errors
    }
    if (error.status >= 500 && error.status < 600) {
      return true; // Server errors
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return true; // Connection errors
    }
    return false;
  },
  onRetry: null
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay for retry attempt with exponential backoff
 */
function calculateDelay(attempt, options) {
  const delay = Math.min(
    options.initialDelay * Math.pow(options.factor, attempt),
    options.maxDelay
  );
  // Add jitter to prevent thundering herd
  const jitter = Math.random() * 0.3 * delay; // Up to 30% jitter
  return Math.floor(delay + jitter);
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {RetryOptions} options - Retry configuration options
 * @returns {Promise} - Result of the function
 */
export async function retry(fn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError;
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if we should retry this error
      if (!opts.shouldRetry(error)) {
        throw error; // Don't retry non-retryable errors
      }
      
      // Don't retry if we've exhausted attempts
      if (attempt >= opts.maxRetries) {
        break;
      }
      
      // Calculate delay before retry
      const delay = calculateDelay(attempt, opts);
      
      // Call onRetry callback if provided
      if (opts.onRetry) {
        opts.onRetry(error, attempt + 1, delay);
      }
      
      // Wait before retrying
      await sleep(delay);
    }
  }
  
  // All retries exhausted
  throw lastError;
}

/**
 * Retry a fetch request with exponential backoff
 * @param {string} url - URL to fetch
 * @param {RequestInit} fetchOptions - Fetch options
 * @param {RetryOptions} retryOptions - Retry configuration options
 * @returns {Promise<Response>} - Fetch response
 */
export async function retryFetch(url, fetchOptions = {}, retryOptions = {}) {
  return retry(async () => {
    const controller = new AbortController();
    const timeout = retryOptions.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Treat 5xx errors as retryable
      if (response.status >= 500 && response.status < 600) {
        const error = new Error(`Server error: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }, retryOptions);
}

/**
 * Create a retryable API client function
 * @param {string} baseUrl - Base URL for API
 * @param {RetryOptions} defaultRetryOptions - Default retry options
 * @returns {Function} - API client function
 */
export function createRetryableApiClient(baseUrl, defaultRetryOptions = {}) {
  return async function apiCall(endpoint, options = {}, retryOptions = {}) {
    const url = `${baseUrl}${endpoint}`;
    const mergedRetryOptions = { ...defaultRetryOptions, ...retryOptions };
    
    return retryFetch(url, options, mergedRetryOptions);
  };
}

