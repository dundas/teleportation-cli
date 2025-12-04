#!/usr/bin/env node

import { stdin, exit, env } from 'node:process';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import metadata extraction (lazy loaded to avoid slowing down startup)
let extractSessionMetadata = null;
async function getSessionMetadata(cwd) {
  if (!extractSessionMetadata) {
    // Try multiple possible paths for the metadata module
    const possiblePaths = [
      // Installed location (copied during `teleportation on`)
      join(homedir(), '.teleportation', 'lib', 'session', 'metadata.js'),
      // Development mode - relative to hooks directory
      join(__dirname, '..', '..', 'lib', 'session', 'metadata.js'),
      // If hook is still in project directory
      join(process.cwd(), 'lib', 'session', 'metadata.js')
    ];

    // Check existsSync first to avoid expensive import failures
    for (const metadataPath of possiblePaths) {
      if (!existsSync(metadataPath)) continue;
      try {
        const metadataModule = await import(metadataPath);
        extractSessionMetadata = metadataModule.extractSessionMetadata;
        if (extractSessionMetadata) break;
      } catch {
        // Try next path
        continue;
      }
    }

    if (!extractSessionMetadata) {
      if (env.DEBUG) console.error(`[SessionStart] Metadata module not found`);
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

// Session marker file to track when this Claude Code session started
const TELEPORTATION_DIR = join(homedir(), '.teleportation');
const SESSION_MARKER_FILE = join(TELEPORTATION_DIR, '.session_marker');
const CREDENTIALS_FILE = join(TELEPORTATION_DIR, 'credentials');

/**
 * Check if credentials were modified after the session started.
 * If a session marker exists and credentials are newer, user needs to restart.
 */
function checkRestartNeeded() {
  try {
    if (!existsSync(SESSION_MARKER_FILE) || !existsSync(CREDENTIALS_FILE)) {
      return { needsRestart: false };
    }

    const markerMtime = statSync(SESSION_MARKER_FILE).mtimeMs;
    const credsMtime = statSync(CREDENTIALS_FILE).mtimeMs;

    if (credsMtime > markerMtime) {
      return {
        needsRestart: true,
        reason: 'Credentials changed after session started',
        markerTime: new Date(markerMtime).toISOString(),
        credsTime: new Date(credsMtime).toISOString()
      };
    }

    return { needsRestart: false };
  } catch (e) {
    if (env.DEBUG) console.error(`[SessionStart] Restart check error: ${e.message}`);
    return { needsRestart: false };
  }
}

/**
 * Update the session marker file with current timestamp.
 * Called when a session starts to track when this Claude Code instance began.
 */
function updateSessionMarker(sessionId) {
  try {
    if (!existsSync(TELEPORTATION_DIR)) {
      mkdirSync(TELEPORTATION_DIR, { recursive: true, mode: 0o700 });
    }
    const markerData = JSON.stringify({
      timestamp: Date.now(),
      sessionId: sessionId,
      startedAt: new Date().toISOString()
    });
    writeFileSync(SESSION_MARKER_FILE, markerData, { mode: 0o600 });
    if (env.DEBUG) console.error(`[SessionStart] Session marker updated`);
  } catch (e) {
    if (env.DEBUG) console.error(`[SessionStart] Failed to update session marker: ${e.message}`);
  }
}

(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch {}

  let { session_id, cwd } = input || {};
  const claude_session_id = session_id;

  // Check if credentials changed since last session start - user may need to restart
  const restartCheck = checkRestartNeeded();
  if (restartCheck.needsRestart) {
    // Output a warning to stderr (shown to user)
    console.error('\n⚠️  Teleportation credentials changed after this session started.');
    console.error('   Restart Claude Code to apply the new credentials.\n');
    if (env.DEBUG) {
      console.error(`   Session started: ${restartCheck.markerTime}`);
      console.error(`   Credentials updated: ${restartCheck.credsTime}`);
    }
  }

  // Update session marker with current time (for future restart detection)
  updateSessionMarker(session_id);

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
        // Extract session metadata (project, branch, hostname, current_model, etc.)
        const meta = await getSessionMetadata(cwd || process.cwd());

        if (env.DEBUG && meta.current_model) {
          console.error(`[SessionStart] Captured model: ${meta.current_model}`);
        }

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

  // Session registration with relay happens on first message (in pre_tool_use hook)
  // This hook just starts the daemon infrastructure
  try { process.stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
  return exit(0);
})();
