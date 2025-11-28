#!/usr/bin/env node
/**
 * Heartbeat Background Process
 * Runs continuously while Claude Code session is active
 * Sends periodic heartbeats to relay API to keep session alive
 *
 * This is NOT a hook - it's a background process spawned by session_start.mjs
 * It runs detached and continues until killed by session_end.mjs
 */

import { env, exit, pid as processPid } from 'node:process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Read configuration from environment variables (secure - not visible in process list)
const SESSION_ID = process.argv[2] || env.SESSION_ID;
const RELAY_API_URL = env.RELAY_API_URL;
const RELAY_API_KEY = env.RELAY_API_KEY;
const HEARTBEAT_INTERVAL = Math.max(100, Math.min(600000,
  parseInt(env.HEARTBEAT_INTERVAL || '120000', 10)
)); // Default 2 minutes, min 100ms (for testing), max 10min
const START_DELAY = Math.max(100, Math.min(60000,
  parseInt(env.START_DELAY || '5000', 10)
)); // Default 5 seconds, min 100ms (for testing), max 1min
const MAX_FAILURES = Math.max(1, Math.min(10,
  parseInt(env.MAX_FAILURES || '3', 10)
)); // Default 3, min 1, max 10
const FETCH_TIMEOUT = Math.max(100, Math.min(30000,
  parseInt(env.FETCH_TIMEOUT || '5000', 10)
)); // Default 5s, min 100ms (for testing), max 30s
const DEBUG = env.TELEPORTATION_DEBUG === 'true';

if (!SESSION_ID || !RELAY_API_URL || !RELAY_API_KEY) {
  console.error('[Heartbeat] Missing required environment variables: SESSION_ID, RELAY_API_URL, RELAY_API_KEY');
  exit(1);
}

const PID_FILE = join(tmpdir(), `teleportation-heartbeat-${SESSION_ID}.pid`);
let intervalHandle = null;
let heartbeatCount = 0;
let failureCount = 0;

/**
 * Check for pending approvals and handle them
 */
async function checkAndHandlePendingApprovals() {
  try {
    // Fetch pending and allowed approvals for this session
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const [pendingResponse, allowedResponse] = await Promise.all([
      fetch(`${RELAY_API_URL}/api/approvals?status=pending&session_id=${SESSION_ID}`, {
        headers: {
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        signal: controller.signal
      }),
      fetch(`${RELAY_API_URL}/api/approvals?status=allowed&session_id=${SESSION_ID}`, {
        headers: {
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        signal: controller.signal
      })
    ]);

    clearTimeout(timeoutId);

    if (!pendingResponse.ok && !allowedResponse.ok) {
      return; // Skip if API calls fail
    }

    const pending = pendingResponse.ok ? await pendingResponse.json() : [];
    const allowed = allowedResponse.ok ? await allowedResponse.json() : [];

    // Find allowed approvals that haven't been acknowledged yet
    const unacknowledged = allowed.filter(a => !a.acknowledgedAt);

    if (unacknowledged.length > 0 && DEBUG) {
      console.log(`[Heartbeat] Found ${unacknowledged.length} approved but unacknowledged approval(s)`);
    }

    // Acknowledge approved approvals (fire-and-forget, don't block heartbeat)
    for (const approval of unacknowledged) {
      try {
        fetch(`${RELAY_API_URL}/api/approvals/${approval.id}/ack`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RELAY_API_KEY}`
          },
          body: JSON.stringify({ processed: true })
        }).catch(() => {}); // Ignore errors - acknowledgment is optional
      } catch (e) {
        // Ignore errors
      }
    }

    // Log if there are pending approvals waiting for user decision
    if (pending.length > 0 && DEBUG) {
      console.log(`[Heartbeat] Session has ${pending.length} pending approval(s) waiting for user decision`);
    }
  } catch (error) {
    // Silently fail - approval checking shouldn't break heartbeat
    if (DEBUG) {
      console.log(`[Heartbeat] Error checking approvals: ${error.message}`);
    }
  }
}

/**
 * Send heartbeat to relay API
 */
async function sendHeartbeat() {
  // Increment count before sending (so first heartbeat is #1, not #0)
  heartbeatCount++;

  try {
    // Add timeout to prevent hanging on unreachable servers
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(`${RELAY_API_URL}/api/sessions/${SESSION_ID}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: processPid,
        count: heartbeatCount
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId); // Clear timeout if request succeeds

    if (response.ok) {
      failureCount = 0; // Reset failure count on success
      
      // Check for pending approvals after successful heartbeat
      // Do this asynchronously so it doesn't block the heartbeat
      checkAndHandlePendingApprovals().catch(() => {});
      
      if (DEBUG) {
        console.log(`[Heartbeat] Sent #${heartbeatCount} for session ${SESSION_ID}`);
      }
    } else {
      heartbeatCount--; // Rollback count on failure
      failureCount++;
      console.error(`[Heartbeat] Failed (${response.status}): ${await response.text()}`);

      if (failureCount >= MAX_FAILURES) {
        console.error(`[Heartbeat] Max failures reached (${MAX_FAILURES}), stopping`);
        await cleanup();
      }
    }
  } catch (error) {
    heartbeatCount--; // Rollback count on error
    failureCount++;
    console.error(`[Heartbeat] Error sending heartbeat:`, error.message);

    if (failureCount >= MAX_FAILURES) {
      console.error(`[Heartbeat] Max failures reached (${MAX_FAILURES}), stopping`);
      await cleanup();
    }
  }
}

/**
 * Cleanup and exit
 */
async function cleanup() {
  console.log(`[Heartbeat] Cleaning up session ${SESSION_ID}`);

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  // Remove PID file
  try {
    await unlink(PID_FILE);
  } catch (error) {
    // Ignore errors - file might not exist
  }

  exit(0);
}

/**
 * Start heartbeat loop
 */
async function start() {
  try {
    // Write PID file with session_id for validation (prevents killing wrong process)
    await writeFile(PID_FILE, JSON.stringify({
      pid: processPid,
      session_id: SESSION_ID,
      started_at: Date.now()
    }), { mode: 0o600 });

    if (DEBUG) {
      console.log(`[Heartbeat] Started for session ${SESSION_ID} (PID: ${processPid})`);
      console.log(`[Heartbeat] Interval: ${HEARTBEAT_INTERVAL}ms, Start delay: ${START_DELAY}ms, Max failures: ${MAX_FAILURES}, Fetch timeout: ${FETCH_TIMEOUT}ms`);
    }

    // Wait for initial delay before first heartbeat
    setTimeout(() => {
      // Send first heartbeat immediately after delay
      sendHeartbeat();

      // Then set up interval for subsequent heartbeats
      intervalHandle = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    }, START_DELAY);

    // Handle graceful shutdown
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGHUP', cleanup);

  } catch (error) {
    console.error(`[Heartbeat] Failed to start:`, error.message);
    exit(1);
  }
}

// Start the heartbeat process
start();
