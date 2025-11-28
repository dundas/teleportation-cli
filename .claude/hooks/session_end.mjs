#!/usr/bin/env node

import { stdin, exit, env } from 'node:process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const readStdin = () => new Promise((resolve, reject) => {
  let data='';
  stdin.setEncoding('utf8');
  stdin.on('data', c => data += c);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch {}

  const { session_id } = input || {};

  // Load config from encrypted credentials, legacy config file, or env vars
  let config;
  try {
    const { loadConfig } = await import('./config-loader.mjs');
    config = await loadConfig();
  } catch (e) {
    // Fallback to environment variables if config loader fails
    config = {
      relayApiUrl: env.RELAY_API_URL || '',
      relayApiKey: env.RELAY_API_KEY || ''
    };
  }

  const RELAY_API_URL = config.relayApiUrl || '';
  const RELAY_API_KEY = config.relayApiKey || '';
  const DAEMON_PORT = config.daemonPort || env.TELEPORTATION_DAEMON_PORT || '3050';
  const DAEMON_ENABLED = config.daemonEnabled !== false && env.TELEPORTATION_DAEMON_ENABLED !== 'false';

  const updateSessionDaemonState = async (updates) => {
    if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) return;
    try {
      await fetch(`${RELAY_API_URL}/api/sessions/${session_id}/daemon-state`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        body: JSON.stringify(updates)
      });
    } catch {}
  };

  // Kill heartbeat background process if running
  if (session_id) {
    try {
      const pidFile = join(tmpdir(), `teleportation-heartbeat-${session_id}.pid`);
      const pidContent = await readFile(pidFile, 'utf8');

      // Parse PID file (now JSON format with session_id validation)
      let pidData;
      try {
        pidData = JSON.parse(pidContent);
      } catch {
        // Fallback for old format (plain PID number)
        pidData = { pid: parseInt(pidContent.trim(), 10) };
      }

      const pid = pidData.pid;

      // Validate session_id matches (prevents killing wrong process)
      if (pid && !isNaN(pid)) {
        if (pidData.session_id && pidData.session_id !== session_id) {
          console.error(`[SessionEnd] PID file session_id mismatch: expected ${session_id}, got ${pidData.session_id}`);
        } else {
          try {
            // Verify process exists before killing
            process.kill(pid, 0); // Signal 0 checks existence without killing

            // Process exists, safe to kill
            process.kill(pid, 'SIGTERM');
            console.log(`[SessionEnd] Killed heartbeat process (PID: ${pid})`);
          } catch (killError) {
            if (killError.code === 'ESRCH') {
              // Process already dead, that's okay
              console.log(`[SessionEnd] Heartbeat process already terminated (PID: ${pid})`);
            } else {
              // Permission error or other issue
              console.error(`[SessionEnd] Failed to kill heartbeat:`, killError.message);
            }
          }
        }
      }

      // Delete PID file
      try {
        await unlink(pidFile);
      } catch (unlinkError) {
        // Ignore errors - file might not exist
      }
    } catch (error) {
      // Ignore errors reading PID file - heartbeat might not have been started
    }
  }

  // Clean up session resources
  if (session_id) {
    try {
      // Cache module loading to prevent memory leaks from repeated imports
      if (!global.__teleportationCleanup) {
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        
        // Try to load cleanup utility from multiple possible locations
        const possiblePaths = [
          join(__dirname, '..', '..', 'lib', 'session', 'cleanup.js'),
          join(process.env.HOME || process.env.USERPROFILE || '', '.teleportation', 'lib', 'session', 'cleanup.js'),
          './lib/session/cleanup.js'
        ];
        
        for (const path of possiblePaths) {
          try {
            global.__teleportationCleanup = await import('file://' + path);
            break;
          } catch (e) {
            // Try next path
          }
        }
      }
      
      const cleanupModule = global.__teleportationCleanup;
      // Use cleanup utility if available, otherwise fall back to direct mute cache clearing
      if (cleanupModule && cleanupModule.cleanupSession) {
        await cleanupModule.cleanupSession(session_id);
      } else {
        // Fallback: try to clear mute cache directly
        if (!global.__teleportationMuteChecker) {
          const { fileURLToPath } = await import('url');
          const { dirname, join } = await import('path');
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = dirname(__filename);
          
          const mutePaths = [
            join(__dirname, '..', '..', 'lib', 'session', 'mute-checker.js'),
            join(process.env.HOME || process.env.USERPROFILE || '', '.teleportation', 'lib', 'session', 'mute-checker.js'),
            './lib/session/mute-checker.js'
          ];
          
          for (const path of mutePaths) {
            try {
              global.__teleportationMuteChecker = await import('file://' + path);
              break;
            } catch (e) {
              // Try next path
            }
          }
        }
        
        const muteChecker = global.__teleportationMuteChecker;
        if (muteChecker && muteChecker.clearMuteCache) {
          muteChecker.clearMuteCache(session_id);
        }
      }
    } catch (e) {
      // Ignore errors in cleanup - session end should always succeed
    }
  }

  if (session_id) {
    await updateSessionDaemonState({
      status: 'stopped',
      started_reason: null,
      is_away: false,
      stopped_reason: 'session_end'
    });
  }

  // Deregister session with daemon
  if (DAEMON_ENABLED && session_id) {
    try {
      const daemonUrl = `http://127.0.0.1:${DAEMON_PORT}`;
      
      // Add timeout to prevent hanging if daemon is unresponsive
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout
      
      try {
        await fetch(`${daemonUrl}/sessions/deregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (env.DEBUG) {
          console.error(`[SessionEnd] Deregistered session from daemon: ${session_id}`);
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError; // Re-throw to be caught by outer try-catch
      }
    } catch (e) {
      // Ignore errors - daemon might not be running
      if (env.DEBUG) {
        console.error(`[SessionEnd] Failed to deregister from daemon:`, e.message);
      }
    }
  }

  // Deregister session with relay API
  if (session_id && RELAY_API_URL && RELAY_API_KEY) {
    try {
      await fetch(`${RELAY_API_URL}/api/sessions/deregister`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        body: JSON.stringify({ session_id })
      });
    } catch (e) {
      // Ignore errors - session end should always succeed even if API is unavailable
    }
  }

  return exit(0);
})();
