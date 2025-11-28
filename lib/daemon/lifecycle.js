import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  checkDaemonStatus,
  acquirePidLock,
  releasePidLock,
  isProcessRunning
} from './pid-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to daemon entry point (relative to lifecycle.js location)
const DAEMON_SCRIPT = join(__dirname, 'teleportation-daemon.js');

/**
 * Start the daemon process
 * @param {Object} options - Start options
 * @param {boolean} options.detached - Run daemon as detached process (default: true)
 * @param {boolean} options.silent - Suppress output (default: true)
 * @returns {Promise<{pid: number, success: boolean}>}
 */
export async function startDaemon(options = {}) {
  const { detached = true, silent = true } = options;

  // Check if daemon is already running
  const status = await checkDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon already running with PID ${status.pid}`);
  }

  // Clean up stale PID file if exists
  if (status.stale) {
    await releasePidLock(status.pid);
  }

  // Spawn daemon process
  const child = spawn(
    process.execPath, // Use same Node.js executable
    [DAEMON_SCRIPT],
    {
      detached,
      stdio: silent ? 'ignore' : 'inherit',
      env: {
        ...process.env,
        TELEPORTATION_DAEMON: 'true'
      }
    }
  );

  // Detach from parent if requested
  if (detached) {
    child.unref();
  }

  // Wait a moment to ensure process started (increase wait time for CI)
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify daemon is running (check multiple times for slow CI)
  let newStatus = await checkDaemonStatus();
  if (!newStatus.running) {
    // Wait a bit more and check again
    await new Promise(resolve => setTimeout(resolve, 1000));
    newStatus = await checkDaemonStatus();
    if (!newStatus.running) {
      throw new Error('Daemon failed to start');
    }
  }

  return {
    pid: child.pid,
    success: true
  };
}

/**
 * Stop the daemon process
 * @param {Object} options - Stop options
 * @param {number} options.timeout - Timeout in ms for graceful shutdown (default: 5000)
 * @param {boolean} options.force - Force kill if graceful shutdown fails (default: true)
 * @returns {Promise<{success: boolean, forced: boolean}>}
 */
export async function stopDaemon(options = {}) {
  const { timeout = 5000, force = true } = options;

  // Check daemon status
  const status = await checkDaemonStatus();
  if (!status.running) {
    return { success: true, forced: false };
  }

  const { pid } = status;

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');

    // Wait for process to exit
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!isProcessRunning(pid)) {
        await releasePidLock(pid);
        return { success: true, forced: false };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Timeout reached, force kill if requested
    if (force) {
      process.kill(pid, 'SIGKILL');

      // Wait a moment for kill to take effect
      await new Promise(resolve => setTimeout(resolve, 200));

      if (!isProcessRunning(pid)) {
        await releasePidLock(pid);
        return { success: true, forced: true };
      }

      throw new Error('Failed to kill daemon process');
    }

    return { success: false, forced: false };
  } catch (err) {
    // Process might have already exited
    if (err.code === 'ESRCH') {
      await releasePidLock(pid);
      return { success: true, forced: false };
    }
    throw err;
  }
}

/**
 * Restart the daemon process
 * @param {Object} options - Restart options
 * @param {number} options.stopTimeout - Timeout for stop operation (default: 5000)
 * @param {boolean} options.force - Force kill on stop timeout (default: true)
 * @returns {Promise<{pid: number, success: boolean, wasRunning: boolean}>}
 */
export async function restartDaemon(options = {}) {
  const { stopTimeout = 5000, force = true } = options;

  // Check if daemon is running
  const status = await checkDaemonStatus();
  const wasRunning = status.running;

  // Stop daemon if running
  if (wasRunning) {
    await stopDaemon({ timeout: stopTimeout, force });
  }

  // Start daemon
  const result = await startDaemon();

  return {
    ...result,
    wasRunning
  };
}

function getRelayConfig() {
  return {
    url: process.env.RELAY_API_URL || '',
    key: process.env.RELAY_API_KEY || ''
  };
}

async function updateSessionDaemonState(sessionId, updates) {
  const { url, key } = getRelayConfig();
  if (!sessionId || !url || !key) return;

  try {
    const res = await fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}/daemon-state`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(updates)
    });

    if (!res.ok && process.env.DEBUG) {
      console.error('[lifecycle] Failed to update daemon_state:', res.status);
    }
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('[lifecycle] Error updating daemon_state:', err.message);
    }
  }
}

export async function startDaemonIfNeeded(sessionId, reason = 'manual') {
  const status = await checkDaemonStatus();

  if (!status.running) {
    await startDaemon();
  }

  if (sessionId) {
    await updateSessionDaemonState(sessionId, {
      status: 'running',
      started_reason: reason
    });
  }
}

export async function stopDaemonIfNeeded(sessionId, reason = 'manual_stop') {
  const status = await checkDaemonStatus();
  if (!status.running) {
    return { stopped: false, reason: 'not_running' };
  }

  // If relay is configured, check if other sessions still have daemon running
  const { url, key } = getRelayConfig();
  if (url && key) {
    try {
      const res = await fetch(`${url}/api/sessions`, {
        headers: { 'Authorization': `Bearer ${key}` }
      });
      if (res.ok) {
        const sessions = await res.json();
        const otherRunning = sessions.some((s) =>
          s.session_id !== sessionId &&
          s.daemon_state &&
          s.daemon_state.status === 'running'
        );

        if (otherRunning) {
          return { stopped: false, reason: 'other_sessions_running' };
        }
      }
    } catch (err) {
      // Fail open: if we can't query sessions, we still attempt to stop daemon
      if (process.env.DEBUG) {
        console.error('[lifecycle] Failed to query sessions before stop:', err.message);
      }
    }
  }

  // Update daemon_state before stopping
  if (sessionId) {
    await updateSessionDaemonState(sessionId, {
      status: 'stopped',
      started_reason: null,
      is_away: false
      // stopped_reason could be added later if DaemonState schema is extended
    });
  }

  const result = await stopDaemon();
  return { stopped: result.success, reason };
}

/**
 * Get daemon status
 * @returns {Promise<{running: boolean, pid: number|null, uptime: number|null}>}
 */
export async function getDaemonStatus() {
  const status = await checkDaemonStatus();

  // TODO: Add uptime calculation once daemon stores start time
  // For now, we can only report running status and PID
  return {
    running: status.running,
    pid: status.pid,
    uptime: null // Will be implemented when daemon stores start timestamp
  };
}

/**
 * Setup signal handlers for graceful daemon shutdown
 * @param {Function} cleanupCallback - Async function to call before exit
 */
export function setupSignalHandlers(cleanupCallback) {
  const handleSignal = async (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);

    try {
      // Run cleanup callback
      if (cleanupCallback) {
        await cleanupCallback();
      }

      // Release PID lock
      await releasePidLock(process.pid);

      process.exit(0);
    } catch (err) {
      console.error('Error during cleanup:', err);
      process.exit(1);
    }
  };

  // Handle termination signals
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    try {
      if (cleanupCallback) {
        await cleanupCallback();
      }
      await releasePidLock(process.pid);
    } catch (cleanupErr) {
      console.error('Error during cleanup:', cleanupErr);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason);
    try {
      if (cleanupCallback) {
        await cleanupCallback();
      }
      await releasePidLock(process.pid);
    } catch (cleanupErr) {
      console.error('Error during cleanup:', cleanupErr);
    }
    process.exit(1);
  });
}

export default {
  startDaemon,
  stopDaemon,
  restartDaemon,
  getDaemonStatus,
  setupSignalHandlers,
  startDaemonIfNeeded,
  stopDaemonIfNeeded
};
