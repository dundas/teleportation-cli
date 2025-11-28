#!/usr/bin/env node
/**
 * PermissionRequest Hook
 * 
 * This hook fires when Claude Code is about to ask the user for permission.
 * This is the RIGHT place to create remote approvals because:
 * 1. We know Claude Code needs user permission (not auto-approved)
 * 2. We can intercept and handle remotely if user is away
 * 
 * Flow:
 * - If user is PRESENT: Let Claude Code show its normal permission dialog
 * - If user is AWAY: Create remote approval and wait for mobile response
 */

import { stdin, stdout, exit, env } from 'node:process';
import { appendFileSync } from 'node:fs';

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => data += chunk);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isValidSessionId = (id) => {
  return id && /^[a-f0-9-]{36}$/i.test(id);
};

const fetchJson = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

(async () => {
  const hookLogFile = env.TELEPORTATION_HOOK_LOG || '/tmp/teleportation-hook.log';
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    try {
      appendFileSync(hookLogFile, `[${timestamp}] [PermissionRequest] ${msg}\n`);
    } catch (e) {}
  };

  log('=== PermissionRequest Hook invoked ===');

  const raw = await readStdin();
  let input;
  try { 
    input = JSON.parse(raw || '{}'); 
  } catch (e) {
    log(`ERROR: Invalid JSON: ${e.message}`);
    return exit(0);
  }

  const { session_id, tool_name, tool_input } = input || {};
  log(`Session: ${session_id}, Tool: ${tool_name}`);

  // Validate session_id
  if (!isValidSessionId(session_id)) {
    log(`ERROR: Invalid session_id format: ${session_id}`);
    return exit(0);
  }

  // Load config
  let config;
  try {
    const { loadConfig } = await import('./config-loader.mjs');
    config = await loadConfig();
  } catch (e) {
    config = {
      relayApiUrl: env.RELAY_API_URL || '',
      relayApiKey: env.RELAY_API_KEY || '',
    };
  }

  const RELAY_API_URL = env.RELAY_API_URL || config.relayApiUrl || '';
  const RELAY_API_KEY = env.RELAY_API_KEY || config.relayApiKey || '';
  const POLLING_INTERVAL_MS = parseInt(env.APPROVAL_POLL_INTERVAL_MS || '2000', 10);
  const APPROVAL_TIMEOUT_MS = parseInt(env.APPROVAL_TIMEOUT_MS || '300000', 10); // 5 min default

  if (!RELAY_API_URL || !RELAY_API_KEY) {
    log('No relay config - letting Claude Code handle permission locally');
    return exit(0);
  }

  // Check if session is in "away" mode
  let isAway = false;
  try {
    const state = await fetchJson(`${RELAY_API_URL}/api/sessions/${session_id}/daemon-state`, {
      headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
    });
    isAway = !!state.is_away;
    log(`Session away status: ${isAway}`);
  } catch (e) {
    // Fail-safe: if relay is down, assume user is present (safer default)
    const failSafe = env.AWAY_CHECK_FAIL_SAFE || 'present';
    isAway = failSafe === 'away';
    log(`Could not check away status: ${e.message} - using fail-safe: ${failSafe}`);
  }

  // Always create an approval request (for remote visibility)
  // But only block/poll if user is away
  log(`Creating remote approval for ${tool_name}...`);

  // Invalidate old pending approvals
  try {
    await fetchJson(`${RELAY_API_URL}/api/approvals/invalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({ session_id, reason: 'New permission request' })
    });
  } catch (e) {
    log(`Warning: Failed to invalidate old approvals: ${e.message}`);
  }

  // Create approval request
  let approvalId;
  try {
    const created = await fetchJson(`${RELAY_API_URL}/api/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({ session_id, tool_name, tool_input })
    });
    approvalId = created.id;
    log(`Approval created: ${approvalId}`);
  } catch (e) {
    log(`ERROR creating approval: ${e.message}`);
    return exit(0); // Let Claude Code handle it
  }

  // If user is NOT away, let Claude Code handle it locally
  // The approval is created for visibility in the mobile UI
  // It will be invalidated when the next tool use happens (or we can mark it as local-handled)
  if (!isAway) {
    log('User is present - letting Claude Code show permission dialog');
    log(`Approval ${approvalId} created for visibility - Claude Code will handle locally`);
    // Don't output anything - Claude Code will show its normal dialog
    // The approval will show in mobile UI until user approves/denies locally
    return exit(0);
  }

  // User is AWAY - poll for remote approval decision
  log('User is AWAY - polling for remote approval');
  const AUTO_AWAY_TIMEOUT_MS = parseInt(env.AUTO_AWAY_TIMEOUT_MS || '300000', 10); // 5 min default
  const startTime = Date.now();
  let hasSetAutoAway = false;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(`${RELAY_API_URL}/api/approvals/${approvalId}`, {
        headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
      });
      consecutiveFailures = 0; // Reset on success

      if (status.status === 'allowed') {
        log('Remote approval: ALLOWED');
        const out = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Approved remotely via Teleportation'
          },
          suppressOutput: true
        };
        stdout.write(JSON.stringify(out));
        return exit(0);
      }

      if (status.status === 'denied') {
        log('Remote approval: DENIED');
        const out = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Denied remotely via Teleportation'
          },
          suppressOutput: true
        };
        stdout.write(JSON.stringify(out));
        return exit(0);
      }

      if (status.status === 'invalidated') {
        log('Approval was invalidated - letting Claude Code handle');
        return exit(0);
      }

      // Auto-set away after timeout (if not already away)
      if (!hasSetAutoAway && (Date.now() - startTime) > AUTO_AWAY_TIMEOUT_MS) {
        const timeoutMinutes = Math.round(AUTO_AWAY_TIMEOUT_MS / 1000 / 60);
        log(`Approval waiting >${timeoutMinutes} minutes - auto-setting away mode`);
        try {
          await fetchJson(`${RELAY_API_URL}/api/sessions/${session_id}/daemon-state`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RELAY_API_KEY}`
            },
            body: JSON.stringify({ is_away: true })
          });
          hasSetAutoAway = true;
        } catch (e) {
          log(`Failed to auto-set away: ${e.message}`);
        }
      }
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`Too many consecutive failures (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) - aborting poll`);
        return exit(0);
      }
      log(`Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
    }

    await sleep(POLLING_INTERVAL_MS);
  }

  // Timeout - let Claude Code handle it
  log('Approval timeout - letting Claude Code handle');
  return exit(0);
})();
