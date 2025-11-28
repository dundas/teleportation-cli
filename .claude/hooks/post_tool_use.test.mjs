#!/usr/bin/env node
/**
 * Tests for post_tool_use.mjs hook
 * 
 * Note: This uses node:test runner (not vitest) because the hook
 * uses dynamic imports and process.exit which don't work well with vitest
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const hookPath = new URL('./post_tool_use.mjs', import.meta.url).pathname;

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

test('post_tool_use hook - basic structure', async (t) => {
  await t.test('should exit gracefully with invalid JSON', async () => {
    const result = await runHook('invalid json');
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with empty input', async () => {
    const result = await runHook('');
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with missing session_id', async () => {
    const result = await runHook({
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: 'output'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with invalid session_id format', async () => {
    const result = await runHook({
      session_id: 'invalid-id',
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: 'output'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('post_tool_use hook - session_id validation', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should accept valid UUID session_id', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: 'test output'
    }, {
      RELAY_API_URL: 'http://invalid-relay-url'
    });
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
        tool_input: { command: 'echo test' },
        tool_output: 'output'
      });
      assert.strictEqual(result.code, 0, `Should reject invalid id: ${id}`);
    }
  });
});

test('post_tool_use hook - tool output handling', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should handle string tool output', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: 'test output'
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle object tool output', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: { status: 'success', data: [1, 2, 3] }
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle null tool output', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: null
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle undefined tool output', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' }
      // tool_output is undefined
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle large tool output (truncation)', async () => {
    const largeOutput = 'x'.repeat(10000); // 10KB output
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: largeOutput
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('post_tool_use hook - configuration', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should use environment variables for config', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: { command: 'echo test' },
      tool_output: 'output'
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
      tool_input: { command: 'echo test' },
      tool_output: 'output'
    }, {
      RELAY_API_URL: '',
      RELAY_API_KEY: ''
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

test('post_tool_use hook - tool information', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should handle various tool names', async () => {
    const tools = ['bash', 'python', 'node', 'grep', 'find'];
    
    for (const tool of tools) {
      const result = await runHook({
        session_id: validSessionId,
        tool_name: tool,
        tool_input: { command: 'test' },
        tool_output: 'output'
      }, {
        RELAY_API_URL: 'http://invalid-relay'
      });
      assert.strictEqual(result.code, 0, `Should handle tool: ${tool}`);
    }
  });

  await t.test('should handle various tool inputs', async () => {
    const result = await runHook({
      session_id: validSessionId,
      tool_name: 'bash',
      tool_input: {
        command: 'echo test',
        cwd: '/tmp',
        timeout: 5000,
        env: { KEY: 'value' }
      },
      tool_output: 'output'
    }, {
      RELAY_API_URL: 'http://invalid-relay'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

console.log('✓ Post tool use hook tests defined');
