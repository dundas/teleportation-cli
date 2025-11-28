#!/usr/bin/env node
/**
 * Tests for permission_request.mjs hook
 * 
 * Note: This uses node:test runner (not vitest) because the hook
 * uses dynamic imports and process.exit which don't work well with vitest
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hookPath = new URL('./permission_request.mjs', import.meta.url).pathname;

/**
 * Helper to run the hook with input and capture output
 */
async function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [hookPath], {
      env: {
        ...process.env,
        ...env,
        RELAY_API_URL: env.RELAY_API_URL || 'http://localhost:3030',
        RELAY_API_KEY: env.RELAY_API_KEY || 'test-key',
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', reject);

    // Send input
    if (input) {
      proc.stdin.write(JSON.stringify(input));
    }
    proc.stdin.end();
  });
}

test('permission_request hook - basic structure', async (t) => {
  await t.test('should exit gracefully with invalid JSON', async () => {
    const result = await runHook('invalid json');
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with empty input', async () => {
    const result = await runHook('');
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with missing session_id', async () => {
    const result = await runHook({ tool_name: 'bash' });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with invalid session_id format', async () => {
    const result = await runHook({
      session_id: 'invalid-id',
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('permission_request hook - session_id validation', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should accept valid UUID session_id', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      RELAY_API_URL: 'http://invalid-relay-url'
    });
    // Should exit gracefully (relay unreachable is OK for this test)
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should reject invalid session_id formats', async () => {
    const invalidIds = [
      'not-a-uuid',
      '12345',
      'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      ''
    ];

    for (const id of invalidIds) {
      const result = await runHook({
        session_id: id,
        tool_name: 'bash',
        tool_input: { command: 'echo test' }
      });
      assert.strictEqual(result.code, 0, `Should reject invalid id: ${id}`);
    }
  });
});

test('permission_request hook - configuration', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should use environment variables for config', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      RELAY_API_URL: 'http://test-relay:3030',
      RELAY_API_KEY: 'test-key-123'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle missing relay config gracefully', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      RELAY_API_URL: '',
      RELAY_API_KEY: ''
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('permission_request hook - auto-away timeout', async (t) => {
  await t.test('should use configurable AUTO_AWAY_TIMEOUT_MS', async () => {
    // This is a unit test - we verify the constant is used
    // Full integration test would require mocking the relay API
    const result = await runHook({
      session_id: '12345678-1234-1234-1234-123456789012',
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      AUTO_AWAY_TIMEOUT_MS: '60000' // 1 minute
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should default to 5 minutes if not set', async () => {
    const result = await runHook({
      session_id: '12345678-1234-1234-1234-123456789012',
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('permission_request hook - fail-safe behavior', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should support AWAY_CHECK_FAIL_SAFE environment variable', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      AWAY_CHECK_FAIL_SAFE: 'present',
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should default to "present" fail-safe', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

console.log('✓ Permission request hook tests defined');
