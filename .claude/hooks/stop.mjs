#!/usr/bin/env node

import { stdin, stdout, stderr, exit, env } from 'node:process';

const readStdin = () => new Promise((resolve, reject) => {
  let data='';
  stdin.setEncoding('utf8');
  stdin.on('data', c => data += c);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

(async () => {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw || '{}'); }
  catch (e) {
    return exit(0);
  }

  const { session_id } = input || {};
  const RELAY_API_URL = env.RELAY_API_URL || '';
  const RELAY_API_KEY = env.RELAY_API_KEY || '';

  if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) return exit(0);

  try {
    const res = await fetch(`${RELAY_API_URL}/api/messages/pending?session_id=${encodeURIComponent(session_id)}`, {
      headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` }
    });
    if (res.ok) {
      const msg = await res.json();
      if (msg && msg.id && msg.text) {
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
    stderr.write(`Stop hook error: ${e.message}\n`);
  }

  return exit(0);
})();
