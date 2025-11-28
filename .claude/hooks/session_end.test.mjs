import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Path to the hook script
const HOOK_PATH = join(process.cwd(), '.claude', 'hooks', 'session_end.mjs');

// Helper to run the hook with mocked inputs and environment
const runHook = (input, env = {}) => {
  return new Promise((resolve) => {
    const proc = spawn('node', [HOOK_PATH], {
      env: {
        ...process.env,
        ...env,
        DEBUG: 'true',
        TELEPORTATION_CONFIG_FROM_ENV_ONLY: 'true'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
};

describe('SessionEnd Hook Tests', () => {
  const MOCK_RELAY_PORT = 3033;
  const MOCK_RELAY_URL = `http://localhost:${MOCK_RELAY_PORT}`;

  let server;
  let daemonState;
  let deregisteredSessionId;

  before(async () => {
    const http = await import('node:http');

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let body = '';

      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const data = body ? JSON.parse(body) : {};

        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }

        if (req.method === 'PATCH' && url.pathname.match(/\/api\/sessions\/.+\/daemon-state/)) {
          daemonState = data;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/sessions/deregister') {
          deregisteredSessionId = data.session_id;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise(r => server.listen(MOCK_RELAY_PORT, r));
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    daemonState = undefined;
    deregisteredSessionId = undefined;
  });

  test('6.6 Session end marks daemon stopped with stopped_reason session_end', async () => {
    const input = { session_id: 'test-session' };

    const env = {
      RELAY_API_URL: MOCK_RELAY_URL,
      RELAY_API_KEY: 'test-key',
      TELEPORTATION_DAEMON_ENABLED: 'false' // avoid daemon deregister HTTP calls in this test
    };

    const result = await runHook(input, env);

    assert.equal(result.code, 0, 'Hook should exit with code 0');

    // Allow async PATCH/deregister to complete
    await new Promise(r => setTimeout(r, 100));

    assert.ok(daemonState, 'Daemon state should be updated');
    assert.equal(daemonState.status, 'stopped');
    assert.equal(daemonState.stopped_reason, 'session_end');
    assert.equal(daemonState.started_reason, null);
    assert.equal(daemonState.is_away, false);

    assert.equal(deregisteredSessionId, 'test-session');
  });
});
