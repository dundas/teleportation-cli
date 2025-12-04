#!/usr/bin/env node
/**
 * Stop Hook
 * 
 * This hook fires when Claude Code finishes responding.
 * 
 * Purpose:
 * 1. Check for pending messages from the mobile app (existing functionality)
 * 2. Extract Claude's last response from the transcript and log it to timeline
 */

import { stdin, stdout, stderr, exit, env } from 'node:process';
import { readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  stdin.setEncoding('utf8');
  stdin.on('data', c => data += c);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

// More lenient session ID validation - accepts any alphanumeric string with hyphens
const isValidSessionId = (id) => {
  return id && typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id) && id.length >= 8;
};

// Max length for assistant response preview (characters)
const ASSISTANT_RESPONSE_MAX_LENGTH = 2000;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Fetch JSON with retry logic
 */
const fetchJsonWithRetry = async (url, opts, log, retries = 0) => {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (error) {
    if (retries < MAX_RETRIES) {
      log(`Retry ${retries + 1}/${MAX_RETRIES} after error: ${error.message}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (retries + 1)));
      return fetchJsonWithRetry(url, opts, log, retries + 1);
    }
    throw error;
  }
};

/**
 * Extract the last assistant message from the transcript
 * The transcript is a JSON file with conversation messages
 */
const extractLastAssistantMessage = async (transcriptPath, log) => {
  try {
    if (!transcriptPath) {
      log('No transcript_path provided');
      return null;
    }

    // Read file directly - handle errors instead of TOCTOU-vulnerable access() check
    let content;
    try {
      content = await readFile(transcriptPath, 'utf8');
    } catch (e) {
      // Handle file access errors specifically
      if (e.code === 'ENOENT') {
        log(`Transcript file not found: ${transcriptPath}`);
        return null;
      }
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        log(`Permission denied reading transcript: ${transcriptPath}`);
        return null;
      }
      log(`Error reading transcript: ${e.code || e.message}`);
      return null;
    }
    let transcript;
    
    // Try parsing as JSON array first
    try {
      transcript = JSON.parse(content);
      log('Parsed transcript as JSON array');
    } catch (e) {
      // Try parsing as JSONL (newline-delimited JSON)
      log('JSON parse failed, trying JSONL format');
      const lines = content.trim().split('\n').filter(l => l.trim());
      transcript = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      log(`Parsed transcript as JSONL (${transcript.length} messages)`);
    }

    if (!Array.isArray(transcript)) {
      log(`Transcript is not an array: ${typeof transcript}`);
      return null;
    }

    log(`Transcript has ${transcript.length} messages`);

    // Find the last assistant message
    // Messages typically have: { role: 'assistant' | 'user', content: string | array }
    for (let i = transcript.length - 1; i >= 0; i--) {
      const msg = transcript[i];
      
      // Check for assistant role (various possible formats)
      const role = msg.role || msg.type || '';
      if (role === 'assistant' || role === 'model' || msg.isAssistant) {
        // Extract content (could be string or array of content blocks)
        let text = '';
        
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Content blocks format: [{ type: 'text', text: '...' }, ...]
          text = msg.content
            .filter(block => block.type === 'text' && block.text)
            .map(block => block.text)
            .join('\n\n'); // Use double newline for paragraph separation
        } else if (msg.text) {
          text = msg.text;
        } else if (msg.message) {
          text = typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message);
        }

        if (text && text.trim()) {
          log(`Found assistant message (${text.length} chars)`);
          return text.trim();
        }
      }
    }

    log('No assistant message found in transcript');
    return null;
  } catch (e) {
    log(`Error reading transcript: ${e.message}`);
    return null;
  }
};

(async () => {
  const hookLogFile = env.TELEPORTATION_HOOK_LOG || '/tmp/teleportation-hook.log';
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    try {
      // Use sync for logging to ensure messages are written even if hook exits quickly
      appendFileSync(hookLogFile, `[${timestamp}] [Stop] ${msg}\n`);
    } catch (e) {}
  };

  log('=== Stop Hook invoked ===');

  const raw = await readStdin();
  let input;
  try { 
    input = JSON.parse(raw || '{}'); 
  } catch (e) {
    log(`ERROR: Invalid JSON: ${e.message}`);
    return exit(0);
  }

  const { session_id, transcript_path, stop_hook_active } = input || {};
  log(`Session: ${session_id}, Transcript: ${transcript_path}, stop_hook_active: ${stop_hook_active}`);

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

  if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) {
    log('Missing session_id or relay config - skipping');
    return exit(0);
  }

  // Validate session_id
  if (!isValidSessionId(session_id)) {
    log(`ERROR: Invalid session_id format: ${session_id}`);
    return exit(0);
  }

  // 1. Extract and log Claude's last response to timeline
  // Skip if this is a continuation from a previous stop hook (stop_hook_active=true)
  // to avoid logging duplicate responses
  if (!stop_hook_active) {
    try {
      const assistantMessage = await extractLastAssistantMessage(transcript_path, log);
      
      if (assistantMessage) {
        // Truncate for timeline storage
        const preview = assistantMessage.length > ASSISTANT_RESPONSE_MAX_LENGTH
          ? assistantMessage.slice(0, ASSISTANT_RESPONSE_MAX_LENGTH) + '...'
          : assistantMessage;

        await fetchJsonWithRetry(`${RELAY_API_URL}/api/timeline`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RELAY_API_KEY}`
          },
          body: JSON.stringify({
            session_id,
            type: 'assistant_response',
            data: {
              message: preview,
              full_length: assistantMessage.length,
              truncated: assistantMessage.length > ASSISTANT_RESPONSE_MAX_LENGTH
            }
          })
        }, log);
        log(`Logged assistant response to timeline (${preview.length} chars)`);
      }
    } catch (e) {
      log(`Failed to log assistant response after ${MAX_RETRIES} retries: ${e.message}`);
      // Don't fail the hook - continue with other functionality
    }
  } else {
    log('Skipping assistant response log (stop_hook_active=true)');
  }

  // 2. Check for pending messages from mobile app (existing functionality)
  try {
    const res = await fetch(`${RELAY_API_URL}/api/messages/pending?session_id=${encodeURIComponent(session_id)}`, {
      headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
    });
    if (res.ok) {
      const msg = await res.json();
      if (msg && msg.id && msg.text) {
        log(`Found pending message: ${String(msg.text).slice(0, 50)}...`);
        try {
          await fetch(`${RELAY_API_URL}/api/messages/${msg.id}/ack`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
          });
        } catch {}

        const out = {
          decision: 'block',
          reason: msg.text,
          hookSpecificOutput: { hookEventName: 'Stop' },
          suppressOutput: true
        };
        stdout.write(JSON.stringify(out));
        return exit(0);
      }
    }
  } catch (e) {
    log(`Error checking pending messages: ${e.message}`);
  }

  log('Stop hook completed');
  return exit(0);
})();
