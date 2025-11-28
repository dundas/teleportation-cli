#!/usr/bin/env node
/**
 * Session mute status checker
 * Checks if a session is muted and caches the result
 */

// Simple in-memory cache for mute status
// Key: session_id, Value: { muted: boolean, timestamp: number }
const muteCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache TTL

/**
 * Check if a session is muted
 * @param {string} sessionId - Session ID to check
 * @param {string} relayApiUrl - Relay API URL
 * @param {string} relayApiKey - Relay API key for authentication
 * @returns {Promise<boolean>} - True if session is muted, false otherwise
 */
export async function isSessionMuted(sessionId, relayApiUrl, relayApiKey) {
  if (!sessionId || !relayApiUrl || !relayApiKey) {
    return false; // Default to not muted if missing info
  }

  // Check cache first
  const cached = muteCache.get(sessionId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.muted;
  }

  // Fetch from API
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // 5-second timeout
  
  try {
    const response = await fetch(`${relayApiUrl}/api/sessions/${sessionId}`, {
      headers: {
        'Authorization': `Bearer ${relayApiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });

    if (response.ok) {
      const session = await response.json();
      const muted = session.muted === true || session.meta?.muted === true;
      
      // Cache the result
      muteCache.set(sessionId, {
        muted,
        timestamp: Date.now()
      });
      
      return muted;
    } else if (response.status === 404) {
      // Session not found - default to not muted
      return false;
    } else {
      // API error - use cached value if available, otherwise default to not muted
      if (cached) {
        return cached.muted;
      }
      return false;
    }
  } catch (error) {
    // Network error or timeout - use cached value if available, otherwise default to not muted
    if (error.name === 'AbortError') {
      // Timeout occurred
      if (cached) {
        return cached.muted;
      }
      return false;
    }
    if (cached) {
      return cached.muted;
    }
    // If no cache and API fails, default to not muted (fail open)
    return false;
  } finally {
    // Always clear timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}

/**
 * Clear mute status cache for a session
 * @param {string} sessionId - Session ID to clear from cache
 */
export function clearMuteCache(sessionId) {
  if (sessionId) {
    muteCache.delete(sessionId);
  }
}

/**
 * Clear all mute status cache
 */
export function clearAllMuteCache() {
  muteCache.clear();
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats() {
  return {
    size: muteCache.size,
    entries: Array.from(muteCache.entries()).map(([id, data]) => ({
      sessionId: id,
      muted: data.muted,
      age: Date.now() - data.timestamp
    }))
  };
}

