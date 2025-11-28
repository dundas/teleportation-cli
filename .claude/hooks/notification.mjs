#!/usr/bin/env node

import { stdin, stdout, exit, env } from 'node:process';

const readStdin = () => new Promise((resolve, reject) => {
  let data='';
  stdin.setEncoding('utf8');
  stdin.on('data', c => data += c);
  stdin.on('end', () => resolve(data));
  stdin.on('error', reject);
});

(async () => {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch {}

  const SLACK_WEBHOOK_URL = env.SLACK_WEBHOOK_URL || '';

  try {
    if (SLACK_WEBHOOK_URL) {
      const text = `Notification: ${input?.message || input?.type || 'Claude Code'}`;
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
    }
  } catch {}

  stdout.write(JSON.stringify({ suppressOutput: true }));
  return exit(0);
})();
