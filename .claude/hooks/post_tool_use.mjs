#!/usr/bin/env node
/**
 * PostToolUse Hook
 * 
 * This hook fires AFTER a tool has been executed.
 * If we get here, the tool was approved (either auto or manually) and ran.
 * 
 * Purpose: Record tool executions to the timeline for activity history.
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

const isValidSessionId = (id) => {
  return id && /^[a-f0-9-]{36}$/i.test(id);
};

const TIMELINE_OUTPUT_PREVIEW_MAX_LENGTH = 500;

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
      appendFileSync(hookLogFile, `[${timestamp}] [PostToolUse] ${msg}\n`);
    } catch (e) {}
  };

  log('=== PostToolUse Hook invoked ===');

  const raw = await readStdin();
  let input;
  try { 
    input = JSON.parse(raw || '{}'); 
  } catch (e) {
    log(`ERROR: Invalid JSON: ${e.message}`);
    return exit(0);
  }

  const { session_id, tool_name, tool_input, tool_output } = input || {};
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

  if (!RELAY_API_URL || !RELAY_API_KEY || !session_id) {
    log('No relay config or session - skipping timeline log');
    return exit(0);
  }

  // Clear any pending approvals for this session since the tool executed successfully
  // This handles the case where Claude Code auto-approved the tool
  try {
    await fetchJson(`${RELAY_API_URL}/api/approvals/invalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({
        session_id,
        reason: `Tool ${tool_name} executed (auto-approved by Claude Code)`
      })
    });
    log(`Cleared pending approvals after tool execution: ${tool_name}`);
  } catch (e) {
    log(`Failed to clear pending approvals: ${e.message}`);
  }

  // Record tool execution to timeline
  try {
    await fetchJson(`${RELAY_API_URL}/api/timeline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({
        session_id,
        type: 'tool_executed',
        data: {
          tool_name,
          tool_input,
          // Include truncated output for context
          tool_output_preview: (() => {
            if (!tool_output) return null;
            try {
              const stringified = JSON.stringify(tool_output);
              const truncated = stringified.slice(0, TIMELINE_OUTPUT_PREVIEW_MAX_LENGTH);
              return stringified.length > TIMELINE_OUTPUT_PREVIEW_MAX_LENGTH ? truncated + '...' : truncated;
            } catch (e) {
              return '[Unserializable output]';
            }
          })()
        }
      })
    });
    log(`Recorded tool execution: ${tool_name}`);
  } catch (e) {
    log(`Failed to record to timeline: ${e.message}`);
  }

  // PostToolUse hooks don't need to output anything
  return exit(0);
})();
