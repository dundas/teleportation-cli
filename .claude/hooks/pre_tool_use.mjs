#!/usr/bin/env node

import { stdin, stdout, exit, env } from 'node:process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => data += chunk);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Lazy-load metadata extraction
let extractSessionMetadata = null;
async function getSessionMetadata(cwd) {
  if (!extractSessionMetadata) {
    try {
      const metadataModule = await import('../../lib/session/metadata.js');
      extractSessionMetadata = metadataModule.extractSessionMetadata;
    } catch (e) {
      return {};
    }
  }
  try {
    return await extractSessionMetadata(cwd);
  } catch (e) {
    return {};
  }
}

const fetchJson = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

(async () => {
  // Debug: Log hook invocation
  const hookLogFile = env.TELEPORTATION_HOOK_LOG || '/tmp/teleportation-hook.log';
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] ${msg}\n`;
    try {
      appendFileSync(hookLogFile, logMsg);
    } catch (e) {
      // Silently ignore log failures - don't write to stderr as it shows in UI
    }
  };

  log('=== Hook invoked ===');
  
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw || '{}'); }
  catch (e) {
    log(`ERROR: Invalid JSON: ${e.message}`);
    return exit(0);
  }

  let { session_id, tool_name, tool_input } = input || {};
  let claude_session_id = session_id; // Keep original ID

  log(`Session ID: ${session_id}, Tool: ${tool_name}, Input: ${JSON.stringify(tool_input).substring(0, 100)}`);

  // Check for /away and /back commands (user typing in Claude Code)
  // These are special commands to toggle away mode
  const command = tool_input?.command || tool_input?.text || '';
  if (typeof command === 'string') {
    const trimmedCmd = command.trim().toLowerCase();
    if (trimmedCmd === '/away' || trimmedCmd === 'teleportation away') {
      log('Detected /away command - setting away mode');
      // Will set away mode after loading config
      tool_input.__teleportation_away = true;
    } else if (trimmedCmd === '/back' || trimmedCmd === 'teleportation back') {
      log('Detected /back command - clearing away mode');
      tool_input.__teleportation_back = true;
    }
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
      relayApiKey: env.RELAY_API_KEY || '',
      slackWebhookUrl: env.SLACK_WEBHOOK_URL || ''
    };
  }

  // Prioritize environment variables over config file (for testing)
  const SLACK_WEBHOOK_URL = env.SLACK_WEBHOOK_URL || config.slackWebhookUrl || '';
  const RELAY_API_URL = env.RELAY_API_URL || config.relayApiUrl || '';
  const RELAY_API_KEY = env.RELAY_API_KEY || config.relayApiKey || '';
  const DAEMON_PORT = config.daemonPort || env.TELEPORTATION_DAEMON_PORT || '3050';
  const DAEMON_ENABLED = config.daemonEnabled !== false && env.TELEPORTATION_DAEMON_ENABLED !== 'false';
  const CONTEXT_DELIVERY_ENABLED = config.contextDeliveryEnabled !== false && env.TELEPORTATION_CONTEXT_DELIVERY_ENABLED !== 'false';

  // Fast polling timeout - how long to wait before handing off to daemon
  // Default: 60 seconds - provides seamless experience before daemon handoff
  // If daemon is disabled, falls back to 2-hour timeout (old behavior)
  const FAST_POLL_TIMEOUT_MS = env.FAST_POLL_TIMEOUT_MS
    ? parseInt(env.FAST_POLL_TIMEOUT_MS, 10)
    : 60_000; // 60 seconds (increased from 10s for better UX)
  const APPROVAL_TIMEOUT_MS = DAEMON_ENABLED ? FAST_POLL_TIMEOUT_MS :
    (config.approvalTimeout !== undefined ? config.approvalTimeout :
      (env.APPROVAL_TIMEOUT_MS ? parseInt(env.APPROVAL_TIMEOUT_MS, 10) : 7_200_000));

  // Polling interval - how often to check for approval decision
  // Default: 5 seconds - reduces API load for long waits
  const POLLING_INTERVAL_MS = config.pollingInterval ||
    (env.POLLING_INTERVAL_MS ? parseInt(env.POLLING_INTERVAL_MS, 10) : 5_000);

  // Whether to wait indefinitely (until approval or session ends)
  const WAIT_INDEFINITELY = APPROVAL_TIMEOUT_MS === 0 || APPROVAL_TIMEOUT_MS === -1;

  // NOTE: We do NOT auto-approve any tools locally.
  // All tool requests are sent to the remote approval system so the user
  // can approve/deny from their mobile device. This enables true remote control.

  // Helper: Format daemon work results into a human-readable message
  const formatDaemonUpdate = (results) => {
    if (!results || results.length === 0) return '';

    const header = `👷 **Daemon Work Update** (${results.length} command${results.length > 1 ? 's' : ''} executed while you were away)\n\n`;
    
    const details = results.map(r => {
      const status = r.exit_code === 0 ? '✅ Success' : `❌ Failed (Exit: ${r.exit_code})`;
      const time = new Date(r.executed_at).toLocaleTimeString();
      const output = r.stdout || r.stderr || '(No output)';
      const excerpt = output.length > 500 ? output.substring(0, 500) + '...' : output;
      
      return `**Command:** \`${r.command}\`\n**Status:** ${status} at ${time}\n**Output:**\n\`\`\`\n${excerpt}\n\`\`\`\n`;
    }).join('\n---\n\n');

    const successCount = results.filter(r => r.exit_code === 0).length;
    const failCount = results.length - successCount;
    const summary = `\n**Summary:** ${successCount} successful, ${failCount} failed.`;

    let message = header + details + summary;
    
    // Truncate if too long (keep under 5000 chars)
    if (message.length > 5000) {
      message = message.substring(0, 5000) + '\n...(truncated)...';
    }
    
    return message;
  };

  // Register session with daemon if enabled
  // Relay auto-creates sessions on first approval, so no need to pre-register there
  if (session_id && DAEMON_ENABLED) {
    try {
      const daemonUrl = `http://127.0.0.1:${DAEMON_PORT}`;
      log(`Registering session with daemon: ${session_id}`);
      const cwd = process.cwd();
      
      // Extract session metadata (project, branch, hostname, etc.)
      const meta = await getSessionMetadata(cwd);
      log(`Session metadata: ${JSON.stringify(meta)}`);
      
      // Use raw fetch to avoid throwing if daemon is down/unresponsive (best effort)
      const res = await fetch(`${daemonUrl}/sessions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id, claude_session_id, cwd, meta })
      }).catch(e => {
        log(`Daemon registration fetch error: ${e.message}`);
        return null;
      });
      if (res && res.ok) {
        log(`Session registered with daemon successfully`);
      } else if (res) {
        log(`Daemon registration returned status ${res.status}`);
      }
    } catch (e) {
      log(`Warning: Failed to register session with daemon: ${e.message}`);
    }
  }

  // Check for pending results from daemon execution
  if (session_id && RELAY_API_URL && RELAY_API_KEY && CONTEXT_DELIVERY_ENABLED) {
    try {
      log(`Checking for pending results for session: ${session_id}`);
      const results = await fetchJson(`${RELAY_API_URL}/api/sessions/${session_id}/results/pending`, {
        headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
      });
      
      if (results && results.length > 0) {
        log(`Found ${results.length} pending results. Formatting update and denying current request to deliver context.`);

        // Mark results as delivered in parallel (best-effort, but wait before exiting)
        try {
          await Promise.allSettled(
            results.map(r =>
              fetch(`${RELAY_API_URL}/api/sessions/${session_id}/results/${r.result_id}/delivered`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
              }).catch(e => {
                log(`Failed to mark result ${r.result_id} delivered: ${e.message}`);
              })
            )
          );
        } catch (markErr) {
          log(`Warning: Error while marking results delivered: ${markErr.message}`);
        }

        const updateMessage = formatDaemonUpdate(results);
        // Log the daemon update but allow the current tool to proceed
        // This prevents blocking errors while still informing Claude of daemon work
        log(`Daemon update delivered: ${updateMessage.substring(0, 200)}...`);
        
        // Output the update message to Claude by denying the current request
        // This forces Claude to read the update before retrying the tool
        const out = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny', // Deny to force reading the update
            permissionDecisionReason: updateMessage
          },
          suppressOutput: true
        };
        stdout.write(JSON.stringify(out));
        return exit(0);
      }
    } catch (e) {
      log(`Warning: Failed to check pending results: ${e.message}`);
    }
  }

  // Helper: Update session daemon state
  const updateSessionState = async (updates) => {
    if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) return;
    try {
      log(`Updating session state: ${JSON.stringify(updates)}`);
      await fetchJson(`${RELAY_API_URL}/api/sessions/${session_id}/daemon-state`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        body: JSON.stringify(updates)
      });
    } catch (e) {
      log(`Warning: Failed to update session state: ${e.message}`);
    }
  };

  // SMART AWAY MODE: Auto-mark as present ("back") on any activity
  // If the user is typing commands locally, they are clearly not away.
  await updateSessionState({ is_away: false });

  // Note: Approval invalidation is handled by PermissionRequest hook
  // to avoid race conditions and duplicate API calls

  // PreToolUse now only handles:
  // 1. Session registration with daemon
  // 2. Checking for pending daemon results
  // 3. Marking user as present (not away)
  //
  // Remote approvals are handled by PermissionRequest hook
  // Tool execution logging is handled by PostToolUse hook
  
  log(`PreToolUse complete for ${tool_name} - letting Claude Code proceed`);
  
  // Don't output anything - let Claude Code handle permissions with its own system
  // The PermissionRequest hook will handle remote approvals if user is away
  // The PostToolUse hook will record tool executions to the timeline
  return exit(0);
})().catch(err => {
  // Log to file but don't write to stderr - stderr shows in UI as "hook error"
  try {
    const hookLogFile = env.TELEPORTATION_HOOK_LOG || '/tmp/teleportation-hook.log';
    appendFileSync(hookLogFile, `[${new Date().toISOString()}] FATAL: ${err.message}\n${err.stack}\n`);
  } catch (e) {
    // Silently ignore
  }
  exit(0);
});
