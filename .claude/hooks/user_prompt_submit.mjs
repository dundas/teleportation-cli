#!/usr/bin/env node

/**
 * UserPromptSubmit Hook
 * Fires when the user submits a prompt to Claude Code
 * Used to detect /model command and log it to timeline
 */

import { stdin, stdout, exit, env } from 'node:process';
import { tmpdir } from 'os';
import { join } from 'path';

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => data += chunk);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch (e) {
    // Invalid JSON - exit gracefully
    try { stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
    return exit(0);
  }

  const { session_id, prompt } = input;

  // Check if user is running /model command
  if (prompt && typeof prompt === 'string') {
    const trimmed = prompt.trim().toLowerCase();

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      // User is switching models - log this intent
      // The actual model change will be detected in pre_tool_use hook

      // Write a marker file to indicate model change is in progress
      try {
        const { writeFile } = await import('fs/promises');
        const MODEL_CHANGE_MARKER = join(tmpdir(), `teleportation-model-changing-${session_id}.txt`);
        await writeFile(MODEL_CHANGE_MARKER, Date.now().toString(), { mode: 0o600 });

        if (env.DEBUG) {
          console.error(`[UserPromptSubmit] Detected /model command for session ${session_id}`);
        }
      } catch (e) {
        // Non-critical - just a marker file
      }

      // Load config and log to timeline
      try {
        const { loadConfig } = await import('./config-loader.mjs');
        const config = await loadConfig();
        const RELAY_API_URL = config.relayApiUrl;
        const RELAY_API_KEY = config.relayApiKey;

        if (RELAY_API_URL && RELAY_API_KEY) {
          await fetch(`${RELAY_API_URL}/api/timeline/log`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RELAY_API_KEY}`
            },
            body: JSON.stringify({
              session_id,
              event_type: 'model_change_requested',
              data: {
                command: prompt,
                timestamp: Date.now()
              }
            })
          });
        }
      } catch (e) {
        // Non-critical - timeline logging is optional
        if (env.DEBUG) {
          console.error(`[UserPromptSubmit] Failed to log model change request: ${e.message}`);
        }
      }
    }
  }

  // Always suppress output from this hook
  try { stdout.write(JSON.stringify({ suppressOutput: true })); } catch {}
  return exit(0);
})();
