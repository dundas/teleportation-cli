#!/usr/bin/env node
/**
 * API Key authentication utilities
 * Validates API keys and tests them against the relay API
 */

import { retryFetch } from '../utils/retry.js';

/**
 * Validate API key format
 * Basic validation - checks for reasonable length and format
 */
export function validateApiKeyFormat(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    return { valid: false, error: 'API key must be a non-empty string' };
  }

  if (apiKey.length < 10) {
    return { valid: false, error: 'API key is too short (minimum 10 characters)' };
  }

  if (apiKey.length > 256) {
    return { valid: false, error: 'API key is too long (maximum 256 characters)' };
  }

  // Basic format check - should contain alphanumeric and some special chars
  if (!/^[a-zA-Z0-9\-_\.]+$/.test(apiKey)) {
    return { valid: false, error: 'API key contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Test API key against relay API with retry logic
 */
export async function testApiKey(apiKey, relayApiUrl, retryOptions = {}) {
  if (!relayApiUrl) {
    return { valid: false, error: 'Relay API URL is required' };
  }

  try {
    const response = await retryFetch(
      `${relayApiUrl}/api/version`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        timeout: 10000,
        shouldRetry: (error) => {
          // Don't retry on 401 (authentication failures)
          if (error.status === 401) {
            return false;
          }
          // Retry on network errors and 5xx server errors
          return true;
        },
        ...retryOptions
      }
    );

    if (response.ok) {
      const data = await response.json();
      return { valid: true, data };
    } else if (response.status === 401) {
      return { valid: false, error: 'Invalid API key - authentication failed. Please check your API key and try again.' };
    } else if (response.status >= 500) {
      return { valid: false, error: `Relay API server error (${response.status}). The server may be temporarily unavailable. Please try again later.` };
    } else {
      return { valid: false, error: `API returned unexpected status ${response.status}. Please check your relay API configuration.` };
    }
  } catch (error) {
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      return { valid: false, error: `Connection timeout: Could not reach relay API at ${relayApiUrl}. Please check your network connection and try again.` };
    }
    if (error.code === 'ENOTFOUND') {
      return { valid: false, error: `Cannot resolve relay API hostname. Please verify the URL is correct: ${relayApiUrl}` };
    }
    if (error.code === 'ECONNREFUSED') {
      return { valid: false, error: `Connection refused: Relay API is not running at ${relayApiUrl}. Start it with 'teleportation start' or check your configuration.` };
    }
    return { valid: false, error: `Failed to test API key: ${error.message}. Please check your network connection and relay API status.` };
  }
}

/**
 * Validate and test API key
 */
export async function validateApiKey(apiKey, relayApiUrl) {
  // First validate format
  const formatCheck = validateApiKeyFormat(apiKey);
  if (!formatCheck.valid) {
    return formatCheck;
  }

  // Then test against API if URL provided
  if (relayApiUrl) {
    return await testApiKey(apiKey, relayApiUrl);
  }

  // Format is valid but can't test without URL
  return { valid: true, warning: 'API key format is valid but not tested (no relay URL)' };
}

