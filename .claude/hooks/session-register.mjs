#!/usr/bin/env node
/**
 * Session Registration Helper
 * Registers a session with the relay API if not already registered.
 * This is called lazily when an approval is created or a message is sent.
 */

import { env } from 'node:process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load version info from ~/.teleportation/version.json
 * Returns null if file doesn't exist (old installation)
 */
async function loadVersionInfo() {
  const versionFile = join(homedir(), '.teleportation', 'version.json');
  try {
    const content = await readFile(versionFile, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    // Version file doesn't exist - old installation
    return null;
  }
}

/**
 * Register a session with the relay API if not already registered
 * @param {string} session_id - Session ID
 * @param {string} cwd - Current working directory
 * @param {object} config - Config object with relayApiUrl and relayApiKey
 * @returns {Promise<boolean>} - True if registered successfully
 */
export async function ensureSessionRegistered(session_id, cwd, config) {
  const RELAY_API_URL = config.relayApiUrl || '';
  const RELAY_API_KEY = config.relayApiKey || '';

  console.error(`[SessionRegister] session_id=${session_id}, RELAY_API_URL=${RELAY_API_URL}, RELAY_API_KEY=${RELAY_API_KEY ? 'set' : 'missing'}`);

  if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) {
    console.error(`[SessionRegister] Early return: session_id=${!!session_id}, RELAY_API_URL=${!!RELAY_API_URL}, RELAY_API_KEY=${!!RELAY_API_KEY}`);
    return false;
  }

  // Extract enhanced session metadata
  let metadata = { cwd };
  try {
    // Try to load metadata extraction module
    const possiblePaths = [
      join(__dirname, '..', '..', 'lib', 'session', 'metadata.js'),
      join(process.env.HOME || process.env.USERPROFILE || '', '.teleportation', 'lib', 'session', 'metadata.js'),
      './lib/session/metadata.js'
    ];

    let metadataModule = null;
    for (const path of possiblePaths) {
      try {
        metadataModule = await import('file://' + path);
        break;
      } catch (e) {
        // Try next path
      }
    }

    if (metadataModule && metadataModule.extractSessionMetadata && cwd) {
      const extracted = await metadataModule.extractSessionMetadata(cwd);
      extracted.session_id = session_id;
      metadata = extracted;
    }
  } catch (e) {
    // If metadata extraction fails, fall back to basic metadata
    if (env.DEBUG) {
      console.error('[SessionRegister] Failed to extract metadata:', e.message);
    }
  }

  // Add version info to metadata
  try {
    const versionInfo = await loadVersionInfo();
    if (versionInfo) {
      metadata.teleportation_version = versionInfo.version;
      metadata.protocol_version = versionInfo.protocol_version;
    }
  } catch (e) {
    // Version info not available - old installation
  }

  try {
    // Check if session is already registered (optional optimization)
    // If it exists, we can skip registration, but re-registering is safe (idempotent)
    // So we'll just register anyway - it's simpler and handles edge cases
    
    console.error(`[SessionRegister] Calling ${RELAY_API_URL}/api/sessions/register`);
    const response = await fetch(`${RELAY_API_URL}/api/sessions/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({ session_id, meta: metadata })
    });

    console.error(`[SessionRegister] Response status: ${response.status}`);
    if (response.ok || response.status === 200) {
      // Start heartbeat if not already running
      try {
        const heartbeatEnabled = config.session?.heartbeat?.enabled !== false;
        const heartbeatInterval = config.session?.heartbeat?.interval || 120000;
        const startDelay = config.session?.heartbeat?.startDelay || 5000;
        const maxFailures = config.session?.heartbeat?.maxFailures || 3;

        if (heartbeatEnabled && RELAY_API_URL && RELAY_API_KEY) {
          const { spawn } = await import('child_process');
          const heartbeatPath = join(__dirname, 'heartbeat.mjs');

          // Check if heartbeat is already running for this session
          const { tmpdir } = await import('os');
          const { readFile } = await import('fs/promises');
          const pidFile = join(tmpdir(), `teleportation-heartbeat-${session_id}.pid`);
          
          let shouldStartHeartbeat = true;
          try {
            await readFile(pidFile);
            // PID file exists, heartbeat might be running
            shouldStartHeartbeat = false;
          } catch (e) {
            // PID file doesn't exist, start heartbeat
          }

          if (shouldStartHeartbeat) {
            const heartbeat = spawn('node', [heartbeatPath, session_id], {
              detached: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                SESSION_ID: session_id,
                RELAY_API_URL,
                RELAY_API_KEY,
                HEARTBEAT_INTERVAL: String(heartbeatInterval),
                START_DELAY: String(startDelay),
                MAX_FAILURES: String(maxFailures),
                TELEPORTATION_DEBUG: process.env.TELEPORTATION_DEBUG || 'false'
              }
            });
            heartbeat.unref();
          }
        }
      } catch (error) {
        // Don't fail registration if heartbeat spawn fails
        if (env.DEBUG) {
          console.error('[SessionRegister] Failed to spawn heartbeat:', error.message);
        }
      }

      return true;
    }
  } catch (e) {
    // Registration failed - this is okay, we'll try again next time
    if (env.DEBUG) {
      console.error('[SessionRegister] Failed to register session:', e.message);
    }
  }

  return false;
}

