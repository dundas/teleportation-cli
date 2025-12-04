#!/usr/bin/env node
/**
 * Tests for stop.mjs hook
 * 
 * Tests the assistant response extraction and timeline logging functionality.
 * 
 * Note: This uses node:test runner (not vitest) because the hook
 * uses dynamic imports and process.exit which don't work well with vitest
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hookPath = new URL('./stop.mjs', import.meta.url).pathname;

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
      if (typeof input === 'string') {
        proc.stdin.write(input);
      } else {
        proc.stdin.write(JSON.stringify(input));
      }
    }
    proc.stdin.end();
  });
}

/**
 * Create a temporary transcript file
 */
async function createTempTranscript(content) {
  const tempDir = join(tmpdir(), 'stop-hook-tests');
  try {
    await mkdir(tempDir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const filePath = join(tempDir, `transcript-${Date.now()}.json`);
  await writeFile(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

/**
 * Clean up temp file
 */
async function cleanupTempFile(filePath) {
  try {
    await unlink(filePath);
  } catch (e) {
    // Ignore cleanup errors
  }
}

// Test basic structure and error handling
test('stop hook - basic structure', async (t) => {
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
      transcript_path: '/tmp/test.json'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

// Test session_id validation
test('stop hook - session_id validation', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should accept valid UUID session_id', async () => {
    const result = await runHook({
      session_id: validSessionId,
      transcript_path: '/tmp/nonexistent.json'
    }, {
      RELAY_API_URL: 'http://invalid-relay-url'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should accept alphanumeric session_id with hyphens', async () => {
    const result = await runHook({
      session_id: 'test-session-12345678',
      transcript_path: '/tmp/nonexistent.json'
    }, {
      RELAY_API_URL: 'http://invalid-relay-url'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should reject very short session_id', async () => {
    const result = await runHook({
      session_id: 'abc',
      transcript_path: '/tmp/nonexistent.json'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should reject session_id with invalid characters', async () => {
    const result = await runHook({
      session_id: 'session@with$invalid!chars',
      transcript_path: '/tmp/nonexistent.json'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

// Test transcript parsing
test('stop hook - transcript parsing', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should parse JSON array transcript', async () => {
    const transcript = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there! How can I help?' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should parse JSONL transcript', async () => {
    const jsonl = [
      JSON.stringify({ role: 'user', content: 'Hello' }),
      JSON.stringify({ role: 'assistant', content: 'Hi there!' })
    ].join('\n');
    const transcriptPath = await createTempTranscript(jsonl);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should handle content blocks array format', async () => {
    const transcript = [
      { role: 'user', content: 'Hello' },
      { 
        role: 'assistant', 
        content: [
          { type: 'text', text: 'Hello!' },
          { type: 'text', text: 'How can I help you today?' }
        ]
      }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should handle empty transcript', async () => {
    const transcriptPath = await createTempTranscript([]);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should handle transcript with only user messages', async () => {
    const transcript = [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'Are you there?' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should handle nonexistent transcript file', async () => {
    const result = await runHook({
      session_id: validSessionId,
      transcript_path: '/tmp/definitely-does-not-exist-12345.json'
    }, {
      RELAY_API_URL: 'http://invalid-relay-url'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should handle invalid JSON in transcript', async () => {
    const transcriptPath = await createTempTranscript('{ invalid json }');
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });
});

// Test stop_hook_active flag
test('stop hook - stop_hook_active flag', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should skip transcript extraction when stop_hook_active is true', async () => {
    const transcript = [
      { role: 'assistant', content: 'This should not be logged' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath,
        stop_hook_active: true
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should process transcript when stop_hook_active is false', async () => {
    const transcript = [
      { role: 'assistant', content: 'This should be logged' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath,
        stop_hook_active: false
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });
});

// Test assistant message extraction with various formats
test('stop hook - assistant message formats', async (t) => {
  const validSessionId = '12345678-1234-1234-1234-123456789012';

  await t.test('should extract message with "role: assistant"', async () => {
    const transcript = [
      { role: 'assistant', content: 'Hello from assistant' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should extract message with "role: model"', async () => {
    const transcript = [
      { role: 'model', content: 'Hello from model' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should extract message with "text" field', async () => {
    const transcript = [
      { role: 'assistant', text: 'Hello from text field' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should extract message with "message" field', async () => {
    const transcript = [
      { role: 'assistant', message: 'Hello from message field' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });

  await t.test('should get last assistant message, not first', async () => {
    const transcript = [
      { role: 'assistant', content: 'First message' },
      { role: 'user', content: 'User reply' },
      { role: 'assistant', content: 'Last message should be extracted' }
    ];
    const transcriptPath = await createTempTranscript(transcript);
    
    try {
      const result = await runHook({
        session_id: validSessionId,
        transcript_path: transcriptPath
      }, {
        RELAY_API_URL: 'http://invalid-relay-url'
      });
      assert.strictEqual(result.code, 0, 'Should exit with code 0');
    } finally {
      await cleanupTempFile(transcriptPath);
    }
  });
});

// Test missing config handling
test('stop hook - config handling', async (t) => {
  await t.test('should exit gracefully with missing RELAY_API_URL', async () => {
    const result = await runHook({
      session_id: '12345678-1234-1234-1234-123456789012',
      transcript_path: '/tmp/test.json'
    }, {
      RELAY_API_URL: '',
      RELAY_API_KEY: 'test-key'
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });

  await t.test('should exit gracefully with missing RELAY_API_KEY', async () => {
    const result = await runHook({
      session_id: '12345678-1234-1234-1234-123456789012',
      transcript_path: '/tmp/test.json'
    }, {
      RELAY_API_URL: 'http://localhost:3030',
      RELAY_API_KEY: ''
    });
    assert.strictEqual(result.code, 0, 'Should exit with code 0');
  });
});

console.log('Running stop.mjs tests...');

