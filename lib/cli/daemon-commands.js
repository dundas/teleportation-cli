/**
 * Daemon Management Commands
 * Handles away mode, back mode, and daemon status commands
 */

import { checkDaemonStatus, startDaemon, stopDaemon } from '../daemon/pid-manager.js';

// Color helpers
const c = {
  red: (text) => '\x1b[0;31m' + text + '\x1b[0m',
  green: (text) => '\x1b[0;32m' + text + '\x1b[0m',
  yellow: (text) => '\x1b[1;33m' + text + '\x1b[0m',
  blue: (text) => '\x1b[0;34m' + text + '\x1b[0m',
  cyan: (text) => '\x1b[0;36m' + text + '\x1b[0m',
};

/**
 * Get relay API configuration from environment
 */
function getRelayConfig() {
  return {
    url: process.env.RELAY_API_URL || '',
    key: process.env.RELAY_API_KEY || '',
  };
}

/**
 * Update session daemon state via Relay API
 */
async function updateSessionDaemonState(sessionId, updates) {
  const { url, key } = getRelayConfig();

  if (!sessionId || !url || !key) {
    return false;
  }

  try {
    const res = await fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}/daemon-state`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      console.error(`[daemon-commands] Failed to update daemon_state: HTTP ${res.status}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[daemon-commands] Error updating daemon_state:`, err.message);
    return false;
  }
}

/**
 * Get current session ID from environment or config
 */
function getSessionId() {
  // Try environment variable first
  if (process.env.TELEPORTATION_SESSION_ID) {
    return process.env.TELEPORTATION_SESSION_ID;
  }

  // Could also check config file or other sources
  // For now, we'll require it to be set
  return null;
}

/**
 * Command: teleportation away
 * Mark session as away and start daemon
 */
export async function commandAway() {
  console.log(c.yellow('🚀 Marking session as away and starting daemon...\n'));

  const sessionId = getSessionId();
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable or use: teleportation away --session <id>\n'));
    process.exit(1);
  }

  try {
    // Update session daemon state
    const updated = await updateSessionDaemonState(sessionId, {
      is_away: true,
      status: 'running',
      started_reason: 'cli_away',
    });

    if (!updated) {
      console.log(c.yellow('⚠️  Warning: Could not update session state via Relay API\n'));
      console.log(c.cyan('Continuing with local daemon start...\n'));
    } else {
      console.log(c.green('✅ Session marked as away in Relay API\n'));
    }

    // Start daemon
    const status = await checkDaemonStatus();
    if (status.running) {
      console.log(c.yellow('⚠️  Daemon already running (PID: ' + status.pid + ')\n'));
    } else {
      const result = await startDaemon();
      if (result.success) {
        console.log(c.green('✅ Daemon started (PID: ' + result.pid + ')\n'));
      } else {
        console.log(c.red('❌ Failed to start daemon: ' + result.error + '\n'));
        process.exit(1);
      }
    }

    console.log(c.green('✅ Session marked as away. Daemon is running.\n'));
    console.log(c.cyan('When you return, run: teleportation back\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

/**
 * Command: teleportation back
 * Mark session as back and stop daemon if no other sessions
 */
export async function commandBack() {
  console.log(c.yellow('🔙 Marking session as back and stopping daemon...\n'));

  const sessionId = getSessionId();
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable or use: teleportation back --session <id>\n'));
    process.exit(1);
  }

  try {
    // Update session daemon state
    const updated = await updateSessionDaemonState(sessionId, {
      is_away: false,
      status: 'stopped',
      started_reason: null,
    });

    if (!updated) {
      console.log(c.yellow('⚠️  Warning: Could not update session state via Relay API\n'));
      console.log(c.cyan('Continuing with local daemon stop...\n'));
    } else {
      console.log(c.green('✅ Session marked as back in Relay API\n'));
    }

    // Check if other sessions still need daemon
    const { url, key } = getRelayConfig();
    let shouldStop = true;

    if (url && key) {
      try {
        const res = await fetch(`${url}/api/sessions`, {
          headers: { 'Authorization': `Bearer ${key}` },
        });

        if (res.ok) {
          const sessions = await res.json();
          const otherRunning = sessions.some(
            (s) =>
              s.session_id !== sessionId &&
              s.daemon_state &&
              s.daemon_state.status === 'running'
          );

          if (otherRunning) {
            console.log(c.yellow('⚠️  Other sessions still have daemon running\n'));
            shouldStop = false;
          }
        }
      } catch (err) {
        console.log(c.yellow('⚠️  Could not check other sessions\n'));
        // Continue with stop anyway
      }
    }

    if (shouldStop) {
      const status = await checkDaemonStatus();
      if (!status.running) {
        console.log(c.yellow('⚠️  Daemon not running\n'));
      } else {
        const result = await stopDaemon();
        if (result.success) {
          console.log(c.green('✅ Daemon stopped\n'));
        } else {
          console.log(c.red('❌ Failed to stop daemon: ' + result.error + '\n'));
          process.exit(1);
        }
      }
    }

    console.log(c.green('✅ Session marked as back.\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

/**
 * Command: teleportation daemon-status
 * Show detailed daemon status
 */
export async function commandDaemonStatus() {
  console.log(c.cyan('\n📊 Daemon Status\n'));

  const sessionId = getSessionId();

  try {
    // Check daemon process
    const status = await checkDaemonStatus();

    console.log(c.yellow('Process:'));
    if (status.running) {
      console.log(c.green(`  Status: Running`));
      console.log(`  PID: ${status.pid}`);
      console.log(`  Uptime: ${formatUptime(status.uptime)}`);
    } else {
      console.log(c.red(`  Status: Stopped`));
    }

    // Get session daemon state from Relay API
    if (sessionId) {
      const { url, key } = getRelayConfig();

      if (url && key) {
        try {
          const res = await fetch(`${url}/api/sessions/${encodeURIComponent(sessionId)}`, {
            headers: { 'Authorization': `Bearer ${key}` },
          });

          if (res.ok) {
            const session = await res.json();
            const daemonState = session.daemon_state;

            if (daemonState) {
              console.log(c.yellow('\nSession State:'));
              console.log(`  Status: ${daemonState.status === 'running' ? c.green('Running') : c.red('Stopped')}`);
              console.log(`  Away: ${daemonState.is_away ? c.yellow('Yes') : c.green('No')}`);

              if (daemonState.started_at) {
                const startedDate = new Date(daemonState.started_at);
                console.log(`  Started: ${startedDate.toLocaleString()}`);
              }

              if (daemonState.started_reason) {
                console.log(`  Started Reason: ${daemonState.started_reason}`);
              }

              if (daemonState.last_approval_location) {
                console.log(`  Last Approval: ${daemonState.last_approval_location}`);
              }

              if (daemonState.stopped_reason) {
                console.log(`  Stopped Reason: ${daemonState.stopped_reason}`);
              }
            }
          }
        } catch (err) {
          console.log(c.yellow('\n⚠️  Could not fetch session state from Relay API\n'));
        }
      }
    }

    console.log();
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  if (!seconds) return 'unknown';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

export default {
  commandAway,
  commandBack,
  commandDaemonStatus,
};
