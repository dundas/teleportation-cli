import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };
let originalFetch;

async function importDaemon() {
  // Ensure module sees current env variables
  vi.resetModules();
  return await import('./teleportation-daemon.js');
}

describe('Teleportation Daemon', () => {
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    process.env = { ...originalEnv };
  });

  describe('buildToolPrompt', () => {
    it('should build structured JSON prompt for Bash command', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Bash', { command: 'ls -la' });
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Bash');
      expect(parsed.parameters.command).toBe('ls -la');
      expect(parsed.mode).toBe('headless_execution');
      expect(parsed.timestamp).toBeTypeOf('number');
    });

    it('should build structured JSON prompt for Write tool', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Write', { file_path: '/path/to/file.txt' });
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Write');
      expect(parsed.parameters.file_path).toBe('/path/to/file.txt');
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should build structured JSON prompt for Edit tool', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Edit', { file_path: '/path/to/file.txt' });
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Edit');
      expect(parsed.parameters.file_path).toBe('/path/to/file.txt');
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should build structured JSON prompt for Read tool', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Read', { file_path: '/path/to/file.txt' });
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Read');
      expect(parsed.parameters.file_path).toBe('/path/to/file.txt');
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should build structured JSON prompt for unknown tool', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('CustomTool', { foo: 'bar', baz: 123 });
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('CustomTool');
      expect(parsed.parameters.foo).toBe('bar');
      expect(parsed.parameters.baz).toBe(123);
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should handle null tool_input', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Bash', null);
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Bash');
      expect(parsed.parameters).toEqual({});
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should handle undefined tool_input', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Bash', undefined);
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Bash');
      expect(parsed.parameters).toEqual({});
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should handle empty tool_input', async () => {
      const { buildToolPrompt } = await importDaemon();
      const prompt = buildToolPrompt('Bash', {});
      const parsed = JSON.parse(prompt);
      expect(parsed.tool).toBe('Bash');
      expect(parsed.parameters).toEqual({});
      expect(parsed.mode).toBe('headless_execution');
    });

    it('should prevent command injection by using JSON format', async () => {
      const { buildToolPrompt } = await importDaemon();
      // Test that malicious input is properly escaped in JSON
      const maliciousInput = { command: 'ls; rm -rf /' };
      const prompt = buildToolPrompt('Bash', maliciousInput);
      const parsed = JSON.parse(prompt);
      
      // The command should be preserved exactly as-is in JSON (not interpreted)
      expect(parsed.parameters.command).toBe('ls; rm -rf /');
      // The prompt should be valid JSON (not a string with command injection)
      expect(() => JSON.parse(prompt)).not.toThrow();
      // The prompt should be structured JSON, not a natural language string
      // This prevents command injection because JSON.parse handles escaping automatically
      expect(parsed.tool).toBe('Bash');
      expect(parsed.mode).toBe('headless_execution');
      // The JSON format ensures the command is treated as data, not executable code
      expect(typeof prompt).toBe('string');
      expect(prompt.startsWith('{')).toBe(true);
      expect(prompt.endsWith('}')).toBe(true);
    });
  });

  describe('storeExecutionResult', () => {
    it('should post execution result to relay API', async () => {
      process.env = {
        ...originalEnv,
        RELAY_API_URL: 'http://relay.test',
        RELAY_API_KEY: 'test-key'
      };

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock;

      const { storeExecutionResult } = await importDaemon();

      const executionResult = {
        exit_code: 0,
        stdout: 'hello',
        stderr: '',
        executed_at: 1234
      };

      await storeExecutionResult('sess-1', 'appr-1', 'Bash', 'echo hello', executionResult);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://relay.test/api/sessions/sess-1/results');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body).toMatchObject({
        approval_id: 'appr-1',
        command: 'echo hello',
        tool_name: 'Bash',
        exit_code: 0,
        stdout: 'hello',
        stderr: '',
        executed_at: 1234
      });
    });

    it('should retry once on network error', async () => {
      process.env = {
        ...originalEnv,
        RELAY_API_URL: 'http://relay.test',
        RELAY_API_KEY: 'test-key'
      };

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ ok: true, status: 200 });
      global.fetch = fetchMock;

      const { storeExecutionResult } = await importDaemon();

      const executionResult = {
        exit_code: 1,
        stdout: '',
        stderr: 'boom',
        executed_at: 5678
      };

      await storeExecutionResult('sess-2', 'appr-2', 'Bash', 'exit 1', executionResult);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('idle timeout', () => {
    it('hasIdleTimedOut should return false when sessions exist', async () => {
      const { hasIdleTimedOut } = await importDaemon();
      const now = 2000;
      const last = 0;
      const timeout = 1000;

      const result = hasIdleTimedOut(now, last, timeout, 1);
      expect(result).toBe(false);
    });

    it('hasIdleTimedOut should return false before timeout with no sessions', async () => {
      const { hasIdleTimedOut } = await importDaemon();
      const now = 500;
      const last = 0;
      const timeout = 1000;

      const result = hasIdleTimedOut(now, last, timeout, 0);
      expect(result).toBe(false);
    });

    it('hasIdleTimedOut should return true after timeout with no sessions', async () => {
      const { hasIdleTimedOut } = await importDaemon();
      const now = 1500;
      const last = 0;
      const timeout = 1000;

      const result = hasIdleTimedOut(now, last, timeout, 0);
      expect(result).toBe(true);
    });

    it('checkIdleTimeout should update lastSessionActivityAt when sessions exist', async () => {
      process.env = {
        ...originalEnv,
        DAEMON_IDLE_TIMEOUT_MS: '60000'
      };

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(100000);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      const daemon = await importDaemon();
      const { __test } = daemon;

      const sessionsMap = __test._getSessionsMap();
      sessionsMap.set('sess-1', { session_id: 'sess-1' });

      __test._setLastSessionActivityAt(0);

      await __test.checkIdleTimeout();

      expect(__test._getLastSessionActivityAt()).toBe(100000);
      expect(exitSpy).not.toHaveBeenCalled();

      nowSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('checkIdleTimeout should exit with code 0 when idle timeout reached with no sessions', async () => {
      process.env = {
        ...originalEnv,
        DAEMON_IDLE_TIMEOUT_MS: '60000'
      };

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(120000);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      const daemon = await importDaemon();
      const { __test } = daemon;

      __test._getSessionsMap().clear();
      __test._setLastSessionActivityAt(0);

      await __test.checkIdleTimeout();

      expect(exitSpy).toHaveBeenCalledWith(0);

      nowSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe('inbox command execution', () => {
    it('executeCommand should return error when session is not registered', async () => {
      const { executeCommand } = await importDaemon();

      const result = await executeCommand('missing-session', 'node -e "process.exit(0)"');

      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(-1);
      expect(result.error).toContain('Session not registered');
    });

    it('executeCommand should execute command for registered session', async () => {
      const daemon = await importDaemon();
      const { __test, executeCommand } = daemon;

      const sessionsMap = __test._getSessionsMap();
      sessionsMap.set('sess-exec-1', { session_id: 'sess-exec-1', cwd: process.cwd(), meta: {} });

      const result = await executeCommand('sess-exec-1', 'node -e "process.exit(0)"');

      expect(result.success).toBe(true);
      expect(result.exit_code).toBe(0);
    });

    it('executeCommand should capture non-zero exit codes', async () => {
      const daemon = await importDaemon();
      const { __test, executeCommand } = daemon;

      const sessionsMap = __test._getSessionsMap();
      sessionsMap.set('sess-exec-2', { session_id: 'sess-exec-2', cwd: process.cwd(), meta: {} });

      const result = await executeCommand('sess-exec-2', 'node -e "process.exit(5)"');

      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(5);
    });

    it('handleInboxMessage should execute command, post result, and ack message', async () => {
      process.env = {
        ...originalEnv,
        RELAY_API_URL: 'http://relay.test',
        RELAY_API_KEY: 'test-key'
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ invalidated: 0 })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ id: 'result-1' })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        });

      global.fetch = fetchMock;

      const daemon = await importDaemon();
      const { __test, handleInboxMessage } = daemon;

      const sessionsMap = __test._getSessionsMap();
      sessionsMap.set('sess-inbox-1', { session_id: 'sess-inbox-1', cwd: process.cwd(), meta: {} });

      const message = {
        id: 'msg-1',
        text: 'node -e "process.exit(0)"',
        meta: { type: 'command', reply_agent_id: 'main' }
      };

      await handleInboxMessage('sess-inbox-1', message);

      expect(fetchMock).toHaveBeenCalledTimes(4);

      // First call: invalidate pending approvals
      const [url0, options0] = fetchMock.mock.calls[0];
      expect(url0).toBe('http://relay.test/api/approvals/invalidate');
      expect(options0.method).toBe('POST');

      // Second call: store execution result in relay
      const [url1, options1] = fetchMock.mock.calls[1];
      expect(url1).toBe('http://relay.test/api/sessions/sess-inbox-1/results');
      expect(options1.method).toBe('POST');
      const body1 = JSON.parse(options1.body);
      expect(body1.approval_id).toBe('msg-1');
      expect(body1.tool_name).toBe('Remote Command');

      // Third call: post result message to inbox
      const [url2, options2] = fetchMock.mock.calls[2];
      expect(url2).toBe('http://relay.test/api/messages');
      expect(options2.method).toBe('POST');
      const body2 = JSON.parse(options2.body);
      expect(body2.session_id).toBe('sess-inbox-1');
      expect(body2.meta.type).toBe('result');
      expect(body2.meta.from_agent_id).toBe('daemon');
      expect(body2.meta.target_agent_id).toBe('main');
      expect(body2.meta.in_reply_to_message_id).toBe('msg-1');
      expect(typeof body2.meta.command_exit_code).toBe('number');
      expect(typeof body2.meta.command_success).toBe('boolean');

      // Fourth call: acknowledge the message
      const [url3, options3] = fetchMock.mock.calls[3];
      expect(url3).toBe('http://relay.test/api/messages/msg-1/ack');
      expect(options3.method).toBe('POST');
    });

    it('handleInboxMessage should only ack non-command messages', async () => {
      process.env = {
        ...originalEnv,
        RELAY_API_URL: 'http://relay.test',
        RELAY_API_KEY: 'test-key'
      };

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      });

      global.fetch = fetchMock;

      const daemon = await importDaemon();
      const { __test, handleInboxMessage } = daemon;

      const sessionsMap = __test._getSessionsMap();
      sessionsMap.set('sess-inbox-2', { session_id: 'sess-inbox-2', cwd: process.cwd(), meta: {} });

      const message = {
        id: 'msg-2',
        text: 'info message',
        meta: { type: 'info' }
      };

      await handleInboxMessage('sess-inbox-2', message);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://relay.test/api/messages/msg-2/ack');
      expect(options.method).toBe('POST');
    });
  });
});
