import { test, describe, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Path to the hook script
const HOOK_PATH = join(process.cwd(), '.claude', 'hooks', 'pre_tool_use.mjs');

// Helper to run the hook with mocked inputs and environment
const runHook = (input, env = {}) => {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      env: { 
        ...process.env, 
        ...env,
        DEBUG: 'true', // Enable debug
        TELEPORTATION_CONFIG_FROM_ENV_ONLY: 'true'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', (code) => {
      try {
        const jsonOutput = stdout ? JSON.parse(stdout) : null;
        resolve({ code, stdout, stderr, jsonOutput });
      } catch (e) {
        resolve({ code, stdout, stderr, jsonOutput: null, parseError: e });
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
};

describe('Pre-Tool-Use Hook Tests', () => {
  const MOCK_RELAY_PORT = 3032;
  const MOCK_RELAY_URL = `http://localhost:${MOCK_RELAY_PORT}`;
  
  // Mock Relay Server
  let server;
  let pendingResults = [];
  let sessionState = {};
  let deliveredResults = [];
  let approvalStatus = { status: 'pending', decision_location: null };

  before(async () => {
    // Create a simple mock server
    const http = await import('node:http');
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let body = '';
      
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const data = body ? JSON.parse(body) : {};

        // CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }

        // Endpoints
        if (req.method === 'POST' && url.pathname === '/api/sessions/register') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'GET' && url.pathname.match(/\/api\/sessions\/.*\/results\/pending/)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(pendingResults));
          return;
        }

        if (req.method === 'POST' && url.pathname.match(/\/api\/sessions\/.*\/results\/.*\/delivered/)) {
          const resultId = url.pathname.split('/')[5];
          deliveredResults.push(resultId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        
        if (req.method === 'PATCH' && url.pathname.match(/\/api\/sessions\/.*\/daemon-state/)) {
          Object.assign(sessionState, data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sessionState));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/approvals') {
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ id: 'mock-approval-id' }));
           return;
        }
        
        if (req.method === 'GET' && url.pathname.match(/\/api\/approvals\/.*/)) {
          // Return current approval status (used for polling in hook)
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(approvalStatus));
          return;
        }

        // Default 404
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
    pendingResults = [];
    sessionState = {};
    deliveredResults = [];
    approvalStatus = { status: 'pending', decision_location: null };
  });

  test('3.0 Pending Results Check & Delivery', async () => {
    // Setup pending results
    pendingResults = [{
      result_id: 'res-123',
      command: 'echo hello',
      exit_code: 0,
      stdout: 'hello world',
      executed_at: Date.now()
    }];

    const input = {
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    };

    const env = {
      RELAY_API_URL: MOCK_RELAY_URL,
      RELAY_API_KEY: 'test-key',
      TELEPORTATION_CONTEXT_DELIVERY_ENABLED: 'true',
      TELEPORTATION_DAEMON_ENABLED: 'false',
      APPROVAL_TIMEOUT_MS: '100' // Short timeout for test
    };

    const result = await runHook(input, env);
    
    // All commands now go through remote approval (no local auto-approve)
    // Hook should return 'allow' after timeout
    assert.equal(result.code, 0, 'Hook should exit with code 0');
    assert.ok(result.jsonOutput, 'Hook should return JSON');
    assert.equal(result.jsonOutput.hookSpecificOutput.permissionDecision, 'allow');

    // Verify delivered marking (async so wait a bit)
    await new Promise(r => setTimeout(r, 100));
    assert.ok(deliveredResults.includes('res-123'), 'Result should be marked as delivered');
  });

  test('4.0 Approval Decision Location Tracking (Local Fallback)', async () => {
    // Setup clean state
    pendingResults = [];
    
    const input = {
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'dangerous-command' }
    };

    const env = {
      RELAY_API_URL: MOCK_RELAY_URL,
      RELAY_API_KEY: 'test-key',
      TELEPORTATION_DAEMON_ENABLED: 'false', // Disable daemon to force immediate timeout/fallback logic
      APPROVAL_TIMEOUT_MS: '100' // Short timeout
    };

    const result = await runHook(input, env);

    // Verify output
    assert.ok(result.jsonOutput, 'Hook should return JSON');
    assert.equal(result.jsonOutput.hookSpecificOutput.permissionDecision, 'allow');

    // Verify session state update (async so wait a bit)
    await new Promise(r => setTimeout(r, 100));
    assert.equal(sessionState.last_approval_location, 'local');
  });

  test('6.4 Daemon start on timeout updates daemon_state', async () => {
    pendingResults = [];

    const input = {
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'long-running-command' }
    };

    const env = {
      RELAY_API_URL: MOCK_RELAY_URL,
      RELAY_API_KEY: 'test-key',
      TELEPORTATION_DAEMON_ENABLED: 'true',
      // Make timeout and polling very short for tests
      FAST_POLL_TIMEOUT_MS: '50',
      POLLING_INTERVAL_MS: '10'
    };

    const result = await runHook(input, env);

    // We should end up in an ask state (either daemon handoff prompt or fallback)
    assert.ok(result.jsonOutput, 'Hook should return JSON');
    assert.equal(result.jsonOutput.hookSpecificOutput.permissionDecision, 'allow');

    // Allow async PATCH to complete
    await new Promise(r => setTimeout(r, 150));

    // Daemon state should indicate it started due to timeout, and daemon handoff is active
    assert.equal(sessionState.status, 'running');
    assert.equal(sessionState.started_reason, 'timeout');
    assert.equal(sessionState.last_approval_location, 'daemon_handoff');
  });

  test('6.5 Daemon stop on local approval updates daemon_state', async () => {
    pendingResults = [];

    // Simulate approval already decided locally before polling
    approvalStatus = {
      status: 'allowed',
      decision_location: 'local',
      decision_reason: 'Approved locally for testing'
    };

    const input = {
      session_id: 'test-session',
      tool_name: 'Bash',
      tool_input: { command: 'dangerous-command' }
    };

    const env = {
      RELAY_API_URL: MOCK_RELAY_URL,
      RELAY_API_KEY: 'test-key',
      TELEPORTATION_DAEMON_ENABLED: 'true',
      APPROVAL_TIMEOUT_MS: '1000'
    };

    const result = await runHook(input, env);

    // Local approval should allow execution
    assert.ok(result.jsonOutput, 'Hook should return JSON');
    assert.equal(result.jsonOutput.hookSpecificOutput.permissionDecision, 'allow');

    // Allow async PATCH to complete
    await new Promise(r => setTimeout(r, 100));

    // Daemon state should be marked as stopped due to local approval
    assert.equal(sessionState.status, 'stopped');
    assert.equal(sessionState.stopped_reason, 'local_approval');
  });
});
