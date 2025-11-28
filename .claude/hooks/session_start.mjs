#!/usr/bin/env node

import { stdin, exit, env } from 'node:process';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import metadata extraction (lazy loaded to avoid slowing down startup)
let extractSessionMetadata = null;
async function getSessionMetadata(cwd) {
  if (!extractSessionMetadata) {
    try {
      const metadataModule = await import('../../lib/session/metadata.js');
      extractSessionMetadata = metadataModule.extractSessionMetadata;
    } catch (e) {
      if (env.DEBUG) console.error(`[SessionStart] Failed to load metadata module: ${e.message}`);
      return {};
    }
  }
  try {
    return await extractSessionMetadata(cwd);
  } catch (e) {
    if (env.DEBUG) console.error(`[SessionStart] Failed to extract metadata: ${e.message}`);
    return {};
  }
}

const readStdin = () => new Promise((resolve, reject) => {
  let data='';
  stdin.setEncoding('utf8');
  stdin.on('data', c => data += c);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

const fetchWithTimeout = (url, opts, timeoutMs = 2000) => {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ]);
};

(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch {}

  let { session_id, cwd } = input || {};
  const claude_session_id = session_id;

  // Override with our own process-unique session ID
  try {
    const { getTeleportationSessionId } = await import('./get-session-id.mjs');
    const uniqueId = getTeleportationSessionId(session_id);
    if (uniqueId) {
      if (env.DEBUG) {
        console.error(`[SessionStart] Overriding Claude session ID ${session_id} with unique ID ${uniqueId}`);
      }
      session_id = uniqueId;
    }
  } catch (e) {
    if (env.DEBUG) console.error(`[SessionStart] Failed to get unique session ID: ${e.message}`);
  }

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

  // Auto-start daemon if enabled
  if (DAEMON_ENABLED && session_id && RELAY_API_URL && RELAY_API_KEY) {
    try {
      // Check if daemon is already running
      const daemonUrl = `http://127.0.0.1:${DAEMON_PORT}`;
      let daemonRunning = false;

      try {
        const healthResponse = await fetchWithTimeout(`${daemonUrl}/health`, {}, 1000);
        daemonRunning = healthResponse.ok;
      } catch {}

      // Start daemon if not running
      if (!daemonRunning) {
        // Try multiple locations to find daemon script
        const possibleLocations = [
          // 1. Installed location (copied during `teleportation on`)
          join(homedir(), '.teleportation', 'daemon', 'teleportation-daemon.js'),
          // 2. Development mode - relative to hooks directory
          join(__dirname, '..', '..', 'lib', 'daemon', 'teleportation-daemon.js'),
          // 3. Environment variable override
          env.TELEPORTATION_DAEMON_SCRIPT
        ].filter(Boolean);

        // Import fs/promises once outside the loop
        const { access } = await import('fs/promises');
        let daemonScript = null;
        for (const location of possibleLocations) {
          try {
            await access(location);
            daemonScript = location;
            break;
          } catch {
            // Try next location
          }
        }

        if (!daemonScript) {
          if (env.DEBUG) {
            console.error('[SessionStart] Daemon script not found. Tried:', possibleLocations);
          }
          // Continue without daemon
          try { process.stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
          return exit(0);
        }

        // Retry daemon start with exponential backoff
        let retries = 3;
        let daemonStarted = false;

        while (retries > 0 && !daemonStarted) {
          try {
            // Spawn daemon process
            spawn(process.execPath, [daemonScript], {
              detached: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                TELEPORTATION_DAEMON: 'true',
                RELAY_API_URL,
                RELAY_API_KEY,
                TELEPORTATION_DAEMON_PORT: DAEMON_PORT
              }
            }).unref();

            // Wait for daemon to start with increasing delays
            const waitTime = 500 * (4 - retries); // 500ms, 1000ms, 1500ms
            await new Promise(r => setTimeout(r, waitTime));

            // Verify daemon is actually running
            try {
              const healthCheck = await fetchWithTimeout(`${daemonUrl}/health`, {}, 2000);
              if (healthCheck.ok) {
                daemonStarted = true;
                if (env.DEBUG) {
                  console.error('[SessionStart] Daemon started successfully');
                }
                break;
              }
            } catch (healthError) {
              if (env.DEBUG) {
                console.error(`[SessionStart] Health check failed: ${healthError.message}`);
              }
            }

            retries--;
            if (retries === 0 && !daemonStarted) {
              if (env.DEBUG) {
                console.error('[SessionStart] Failed to start daemon after 3 attempts');
              }
              // Set flag to disable daemon for this session
              process.env.TELEPORTATION_DAEMON_DISABLED = 'true';
            }
          } catch (spawnError) {
            retries--;
            if (env.DEBUG) {
              console.error(`[SessionStart] Daemon spawn error (${3 - retries}/3):`, spawnError.message);
            }
            if (retries > 0) {
              // Exponential backoff between retries
              await new Promise(r => setTimeout(r, 1000 * (4 - retries)));
            }
          }
        }
      }

      // Register session with daemon (with metadata)
      try {
        // Extract session metadata (project, branch, hostname, etc.)
        const meta = await getSessionMetadata(cwd || process.cwd());
        
        await fetchWithTimeout(`${daemonUrl}/sessions/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id, claude_session_id, cwd, meta })
        }, 2000);

        if (env.DEBUG) {
          console.error(`[SessionStart] Session registered with daemon: ${session_id}`);
          console.error(`[SessionStart] Metadata: ${JSON.stringify(meta)}`);
        }
      } catch (regError) {
        if (env.DEBUG) {
          console.error(`[SessionStart] Failed to register session with daemon:`, regError.message);
        }
      }
    } catch (daemonError) {
      // Don't fail session start if daemon fails
      if (env.DEBUG) {
        console.error('[SessionStart] Daemon error:', daemonError.message);
      }
    }
  }

  // Sessions are now registered lazily when needed (on approval creation or message send)
  // Auto-registration on session start is disabled by default
  // Set AUTO_REGISTER_SESSION=true to enable old behavior
  const AUTO_REGISTER_SESSION = env.AUTO_REGISTER_SESSION === 'true';

  if (!AUTO_REGISTER_SESSION) {
    // Just exit - session will be registered when first approval/message is created
    try { process.stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
    return exit(0);
  }

  // Legacy behavior: auto-register on session start (only if AUTO_REGISTER_SESSION=true)
  if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) return exit(0);

  try {
    const { ensureSessionRegistered } = await import('./session-register.mjs');
    await ensureSessionRegistered(session_id, cwd, config);
  } catch (error) {
    // Don't fail session start if registration fails
    if (env.DEBUG) {
      console.error('[SessionStart] Failed to register session:', error.message);
    }
  }

  try { process.stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
  return exit(0);
})();
