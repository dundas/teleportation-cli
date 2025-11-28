#!/usr/bin/env node
/**
 * Session cleanup utilities
 * Handles cleanup of session-related caches and resources
 */

/**
 * Clean up all session-related caches and resources
 * @param {string} sessionId - Session ID to clean up
 * @returns {Promise<void>}
 */
export async function cleanupSession(sessionId) {
  if (!sessionId) {
    return;
  }

  // 1. Clear mute cache
  try {
    const { clearMuteCache } = await import('./mute-checker.js');
    if (clearMuteCache) {
      clearMuteCache(sessionId);
    }
  } catch (e) {
    // Mute checker might not be available, ignore
  }

  // 2. Clear any other session-specific caches
  // (Add more cleanup tasks here as needed)
  // Note: If adding async cleanup tasks, use Promise.allSettled() here
}

/**
 * Clean up all sessions (used for global cleanup)
 * @returns {Promise<void>}
 */
export async function cleanupAllSessions() {
  try {
    const { clearAllMuteCache } = await import('./mute-checker.js');
    if (clearAllMuteCache) {
      clearAllMuteCache();
    }
  } catch (e) {
    // Mute checker might not be available, ignore
  }
}

/**
 * Check if a session has timed out based on last activity
 * @param {number} lastActivityTimestamp - Last activity timestamp (milliseconds)
 * @param {number} timeoutMs - Timeout in milliseconds (default: 1 hour)
 * @returns {boolean} - True if session has timed out
 */
export function isSessionTimedOut(lastActivityTimestamp, timeoutMs = 3600000) {
  if (lastActivityTimestamp == null) { // null or undefined, but not 0
    return false; // No timestamp means can't determine timeout
  }
  const now = Date.now();
  const age = now - lastActivityTimestamp;
  return age > timeoutMs;
}

/**
 * Get session age in milliseconds
 * @param {number} lastActivityTimestamp - Last activity timestamp (milliseconds)
 * @returns {number} - Age in milliseconds, or 0 if no timestamp
 */
export function getSessionAge(lastActivityTimestamp) {
  if (lastActivityTimestamp == null) { // null or undefined, but not 0
    return 0;
  }
  return Date.now() - lastActivityTimestamp;
}

/**
 * Format session age as human-readable string
 * @param {number} lastActivityTimestamp - Last activity timestamp (milliseconds)
 * @returns {string} - Human-readable age string
 */
export function formatSessionAge(lastActivityTimestamp) {
  const age = getSessionAge(lastActivityTimestamp);
  if (age === 0) {
    return 'unknown';
  }

  const seconds = Math.floor(age / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

