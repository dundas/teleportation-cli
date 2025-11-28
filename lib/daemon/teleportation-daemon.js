#!/usr/bin/env node

/**
 * Teleportation Daemon
 *
 * Persistent background service that:
 * - Polls relay API for approved tool requests
 * - Spawns child Claude Code processes via `claude --resume <session_id> -p "<prompt>"`
 * - Executes approved tools asynchronously when user is away
 * - Maintains session registry and approval queue
 * - Provides HTTP server for hook communication
 *
 * SECURITY ARCHITECTURE:
 * ----------------------
 * This daemon executes shell commands via spawn('sh', ['-c', command]) which bypasses
 * Claude CLI's built-in security controls. This is an intentional architectural decision
 * to enable remote approval/execution, but requires defense-in-depth measures:
 *
 * 1. COMMAND WHITELIST: Only pre-approved command prefixes are allowed (see ALLOWED_COMMAND_PREFIXES)
 * 2. SHELL INJECTION BLOCKING: Commands containing metacharacters (;|&`$() etc.) are rejected
 * 3. APPROVAL FLOW: All commands must be explicitly approved via the relay API
 * 4. DEVELOPMENT BYPASS: ALLOW_ALL_COMMANDS requires TELEPORTATION_DANGER_ZONE confirmation
 *
 * For production deployments requiring Claude CLI integration, consider:
 * - Using the CLAUDE_CLI_PATH environment variable to specify a custom Claude CLI wrapper
 * - Implementing additional command validation in a proxy layer
 * - Enabling audit logging by setting DEBUG=1
 */

import http from 'http';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { acquirePidLock, releasePidLock } from './pid-manager.js';
import { setupSignalHandlers } from './lifecycle.js';

const execAsync = promisify(exec);
console.log('[daemon] Starting up...');

const PORT = parseInt(process.env.TELEPORTATION_DAEMON_PORT || '3050', 10);
const RELAY_API_URL = process.env.RELAY_API_URL || 'https://api.teleportation.dev';
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.DAEMON_POLL_INTERVAL_MS || '5000', 10);
const CHILD_TIMEOUT_MS = parseInt(process.env.DAEMON_CHILD_TIMEOUT_MS || '600000', 10); // 10 min
const IDLE_CHECK_INTERVAL_MS = parseInt(process.env.DAEMON_IDLE_CHECK_INTERVAL_MS || '300000', 10); // 5 min
const IDLE_TIMEOUT_MS = parseInt(process.env.DAEMON_IDLE_TIMEOUT_MS || '1800000', 10); // 30 min
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude'; // Configurable Claude CLI path
const ALLOW_ALL_COMMANDS = process.env.TELEPORTATION_DAEMON_ALLOW_ALL_COMMANDS === 'true';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.DAEMON_HEARTBEAT_INTERVAL_MS || '30000', 10); // 30 sec default

// Heartbeat tracking: session_id -> { count, lastSent }
const heartbeatState = new Map();
let lastHeartbeatTime = 0;

// Session registry: session_id -> { session_id, cwd, meta, registered_at }
const sessions = new Map();

// Approval queue: FIFO queue of pending approvals
// { approval_id, session_id, tool_name, tool_input, queued_at }
const approvalQueue = [];

// Maximum queue size to prevent memory exhaustion (DoS prevention)
const MAX_QUEUE_SIZE = 1000;

// Execution tracking: approval_id -> { status, started_at, completed_at, exit_code, stdout, stderr, error }
const executions = new Map();

// Maximum number of executions to keep in memory (LRU cache)
const MAX_EXECUTIONS = 1000; // Maximum executions to keep in memory (LRU cache)

// Maximum output size to prevent memory issues
const MAX_OUTPUT_SIZE = 100_000; // 100KB

// Command whitelist for inbox execution (security: prevents arbitrary command execution)
// Only commands starting with these prefixes are allowed
const ALLOWED_COMMAND_PREFIXES = [
  'git ',        // Git operations
  'npm ',        // NPM package management
  'npx ',        // NPX execution
  'node ',       // Node.js execution
  'ls',          // List files (ls, ls -la, etc.)
  'cat ',        // View file contents
  'head ',       // View file head
  'tail ',       // View file tail
  'grep ',       // Search in files
  'find ',       // Find files
  'pwd',         // Print working directory
  'echo ',       // Echo output
  'mkdir ',      // Create directories
  'touch ',      // Create files
  'cp ',         // Copy files
  'mv ',         // Move files
  // 'rm ' removed - too dangerous for remote execution (could allow rm -rf /)
  'chmod ',      // Change permissions
  'wc ',         // Word count
  'sort ',       // Sort output
  'uniq ',       // Unique lines
  'cut ',        // Cut columns
  'diff ',       // Compare files
  'which ',      // Find executables
  'env',         // Show environment
  'date',        // Show date
  'whoami',      // Show current user
  'hostname',    // Show hostname
];

/**
 * SECURITY: Shell injection detection
 * Block characters that can chain or inject additional commands
 * Note: Parentheses/brackets allowed within quoted strings (e.g., node -e "code()")
 */
const COMMAND_INJECTION_PATTERNS = [
  /;/,           // Command chaining: cmd1; cmd2
  /\|/,          // Piping: cmd1 | cmd2
  /&/,           // Background/AND: cmd1 & cmd2, cmd1 && cmd2
  /`/,           // Backtick substitution: `cmd`
  /\$\(/,        // Command substitution: $(cmd)
  /\$\{/,        // Variable expansion: ${var}
  /\n|\r/,       // Newlines (command separation)
  />\s*>/,       // Append redirect: >>
  /<\s*</,       // Here-string: <<
];

/**
 * Sanitize command by checking for shell injection patterns
 * @param {string} command - The command to sanitize
 * @returns {{ safe: boolean, reason?: string }}
 */
function sanitizeCommand(command) {
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(command)) {
      const match = command.match(pattern);
      return {
        safe: false,
        reason: `Command contains shell injection pattern: '${match[0]}'`
      };
    }
  }
  return { safe: true };
}

/**
 * Check if a command is allowed based on the whitelist
 * @param {string} command - The command to validate
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isCommandAllowed(command) {
  if (!command || typeof command !== 'string') {
    return { allowed: false, reason: 'Command must be a non-empty string' };
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: 'Command cannot be empty' };
  }

  // SECURITY: Check for shell metacharacters first
  const sanitizeResult = sanitizeCommand(trimmed);
  if (!sanitizeResult.safe) {
    console.warn(`[daemon] SECURITY: Blocked command with shell metacharacters: ${trimmed.substring(0, 50)}...`);
    return { allowed: false, reason: sanitizeResult.reason };
  }

  // Optional escape hatch for development: allow any command when explicitly enabled
  // SECURITY: Requires both ALLOW_ALL_COMMANDS=true AND explicit confirmation to prevent accidental enabling
  if (ALLOW_ALL_COMMANDS) {
    // Block in production environment
    if (process.env.NODE_ENV === 'production') {
      console.error('[daemon] SECURITY: ALLOW_ALL_COMMANDS is not permitted in production');
      return { allowed: false, reason: 'Command whitelist bypass disabled in production' };
    }
    // Require explicit confirmation variable (NODE_ENV defaults to undefined in most deployments)
    // This ensures ALLOW_ALL_COMMANDS cannot be accidentally enabled
    const dangerConfirm = process.env.TELEPORTATION_DANGER_ZONE;
    if (dangerConfirm !== 'i_understand_the_risks') {
      console.error('[daemon] SECURITY: ALLOW_ALL_COMMANDS requires TELEPORTATION_DANGER_ZONE=i_understand_the_risks');
      return { allowed: false, reason: 'Command whitelist bypass requires explicit danger zone confirmation' };
    }
    // Log with timestamp for audit trail
    console.warn(`[daemon] ⚠️  SECURITY WARNING: Command whitelist bypass enabled at ${new Date().toISOString()} - ALLOW_ALL_COMMANDS=true`);
    console.warn(`[daemon] ⚠️  Bypassing whitelist for command: ${trimmed.substring(0, 100)}`);
    return { allowed: true };
  }

  // Check against whitelist
  for (const prefix of ALLOWED_COMMAND_PREFIXES) {
    if (trimmed === prefix.trim() || trimmed.startsWith(prefix)) {
      return { allowed: true };
    }
  }

  // Command not in whitelist
  const cmdName = trimmed.split(/\s+/)[0];
  return {
    allowed: false,
    reason: `Command '${cmdName}' is not in the allowed whitelist. Allowed: ${ALLOWED_COMMAND_PREFIXES.map(p => p.trim().split(' ')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`
  };
}

// Cleanup interval: remove old executions every hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let server = null;
let pollingTimer = null;
let cleanupTimer = null;
let idleTimer = null;
let isShuttingDown = false;

// Track last time we had any registered sessions (or last time we checked while sessions were present)
let lastSessionActivityAt = Date.now();

/**
 * HTTP Server for Hook Communication
 * Uses Node.js built-in http module (no external dependencies)
 */

// Helper to truncate output with indicator
function truncateOutput(output, label) {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }
  const truncated = output.slice(0, MAX_OUTPUT_SIZE);
  const remaining = output.length - MAX_OUTPUT_SIZE;
  return `${truncated}\n\n[${label} TRUNCATED - ${remaining} bytes omitted. Total: ${output.length} bytes]`;
}

// Helper to parse JSON body with size limit (DoS prevention)
async function parseJSONBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON: ' + e.message));
      }
    });

    req.on('error', reject);
  });
}

// Validation helpers
function validateSessionId(session_id) {
  if (!session_id || typeof session_id !== 'string') {
    throw new Error('session_id must be a non-empty string');
  }
  if (session_id.length > 256) {
    throw new Error('session_id too long (max 256 characters)');
  }
  // Allow @ and . for user@host format
  if (!/^[a-zA-Z0-9_@.-]+$/.test(session_id)) {
    throw new Error('session_id contains invalid characters (only alphanumeric, dash, underscore, @, . allowed)');
  }
  return session_id;
}

function validateApprovalId(approval_id) {
  if (!approval_id || typeof approval_id !== 'string') {
    throw new Error('approval_id must be a non-empty string');
  }
  if (approval_id.length > 256) {
    throw new Error('approval_id too long (max 256 characters)');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(approval_id)) {
    throw new Error('approval_id contains invalid characters');
  }
  return approval_id;
}

function validateToolName(tool_name) {
  if (!tool_name || typeof tool_name !== 'string') {
    throw new Error('tool_name must be a non-empty string');
  }
  if (tool_name.length > 100) {
    throw new Error('tool_name too long (max 100 characters)');
  }
  // Tool names should be alphanumeric with underscores
  if (!/^[a-zA-Z0-9_]+$/.test(tool_name)) {
    throw new Error('tool_name contains invalid characters');
  }
  return tool_name;
}

// Helper to send JSON response
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// HTTP request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const pathname = url.pathname;

  // CORS headers for localhost
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  try {
    // Health check
    if (method === 'GET' && pathname === '/health') {
      sendJSON(res, 200, {
        status: 'healthy',
        uptime: process.uptime(),
        sessions: sessions.size,
        queue: approvalQueue.length,
        executions: executions.size
      });
      return;
    }

    // Register session
    if (method === 'POST' && pathname === '/sessions/register') {
      const body = await parseJSONBody(req);
      const { session_id, claude_session_id, cwd, meta } = body;

      // Validate session_id
      try {
        validateSessionId(session_id);
      } catch (validationError) {
        sendJSON(res, 400, { error: validationError.message });
        return;
      }

      // Validate cwd if provided
      if (cwd && typeof cwd !== 'string') {
        sendJSON(res, 400, { error: 'cwd must be a string' });
        return;
      }

      sessions.set(session_id, {
        session_id,
        claude_session_id: claude_session_id || session_id, // Fallback to session_id if not provided
        cwd: cwd || process.cwd(),
        meta: {
          ...(meta || {}),
          daemon_pid: process.pid // Add daemon PID to metadata
        },
        registered_at: Date.now()
      });

      console.log(`[daemon] Session registered: ${session_id} (claude_id: ${claude_session_id || session_id}) (daemon_pid: ${process.pid}) (cwd: ${cwd || process.cwd()})`);
      sendJSON(res, 200, { ok: true });
      return;
    }


    // Queue approval for daemon handling
    if (method === 'POST' && pathname === '/approvals/handoff') {
      const body = await parseJSONBody(req);
      const { approval_id, session_id, tool_name, tool_input } = body;

      // Validate all required fields
      try {
        validateApprovalId(approval_id);
        validateSessionId(session_id);
        validateToolName(tool_name);
      } catch (validationError) {
        sendJSON(res, 400, { error: validationError.message });
        return;
      }

      // Validate tool_input if provided (should be an object)
      if (tool_input !== undefined && tool_input !== null && typeof tool_input !== 'object') {
        sendJSON(res, 400, { error: 'tool_input must be an object' });
        return;
      }

      // Check queue size limit to prevent memory exhaustion (DoS prevention)
      if (approvalQueue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[daemon] Approval queue full (${approvalQueue.length}/${MAX_QUEUE_SIZE})`);
        sendJSON(res, 503, {
          error: 'Approval queue full',
          queue_size: approvalQueue.length,
          max_size: MAX_QUEUE_SIZE,
          message: 'Too many pending approvals. Please wait for some to complete.'
        });
        return;
      }

      // Add to queue if not already present
      if (!approvalQueue.find(a => a.approval_id === approval_id)) {
        approvalQueue.push({
          approval_id,
          session_id,
          tool_name,
          tool_input,
          queued_at: Date.now()
        });
        console.log(`[daemon] Approval queued: ${approval_id} (${tool_name}) [${approvalQueue.length}/${MAX_QUEUE_SIZE}]`);
      }

      sendJSON(res, 200, { ok: true, queued: true });
      return;
    }

    // Get execution status
    if (method === 'GET' && pathname.startsWith('/executions/')) {
      const approval_id = pathname.split('/executions/')[1];
      const execution = executions.get(approval_id);

      if (!execution) {
        sendJSON(res, 404, { error: 'not_found' });
        return;
      }

      sendJSON(res, 200, execution);
      return;
    }

    // 404 for unknown routes
    sendJSON(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(`[daemon] Request error:`, error.message);
    sendJSON(res, 500, { error: error.message });
  }
}

function hasIdleTimedOut(now, lastActivityAt, timeoutMs, sessionCount) {
  if (sessionCount > 0) return false;
  return now - lastActivityAt >= timeoutMs;
}

async function checkIdleTimeout() {
  if (isShuttingDown) return;

  const now = Date.now();

  if (sessions.size > 0) {
    lastSessionActivityAt = now;
    return;
  }

  if (!hasIdleTimedOut(now, lastSessionActivityAt, IDLE_TIMEOUT_MS, sessions.size)) {
    return;
  }

  const minutes = Math.round(IDLE_TIMEOUT_MS / 60000);
  console.log(`[daemon] No active sessions for ${minutes} minute(s). Shutting down due to idle timeout.`);

  // Double-check: prevent race condition where session registers during shutdown
  if (sessions.size > 0) {
    console.log('[daemon] New session registered during shutdown check, canceling idle timeout');
    lastSessionActivityAt = Date.now();
    return;
  }

  await cleanup();
  // Exit after idle timeout - tests mock process.exit to verify this behavior
  process.exit(0);
}

/**
 * Execute a shell command in the session's working directory
 * Returns { success, stdout, stderr, exit_code, error }
 *
 * Security: Commands must be in the ALLOWED_COMMAND_PREFIXES whitelist
 */
async function executeCommand(session_id, command) {
  const session = sessions.get(session_id);
  if (!session) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exit_code: -1,
      error: `Session not registered: ${session_id}`
    };
  }

  // Security: Validate command against whitelist
  const validation = isCommandAllowed(command);
  if (!validation.allowed) {
    console.log(`[daemon] Command rejected (not in whitelist): ${command.slice(0, 100)}`);
    return {
      success: false,
      stdout: '',
      stderr: '',
      exit_code: -1,
      error: validation.reason
    };
  }

  const cwd = session.cwd || process.cwd();
  const timeout = 30000; // 30 second timeout for shell commands

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 // 1MB max output
    });

    return {
      success: true,
      stdout: truncateOutput(stdout, 'STDOUT'),
      stderr: truncateOutput(stderr, 'STDERR'),
      exit_code: 0,
      error: null
    };
  } catch (error) {
    // exec throws on non-zero exit codes
    return {
      success: false,
      stdout: truncateOutput(error.stdout || '', 'STDOUT'),
      stderr: truncateOutput(error.stderr || '', 'STDERR'),
      exit_code: error.code || -1,
      error: error.message
    };
  }
}

async function handleInboxMessage(session_id, message) {
  try {
    const preview = (message.text || '').slice(0, 200).replace(/\s+/g, ' ');
    console.log(`[daemon] Inbox message for session ${session_id}: ${message.id} - ${preview}`);

    const meta = message.meta || {};

    // For command messages, execute the command and post result back to the main agent inbox
    if (meta.type === 'command') {
      const replyAgentId = meta.reply_agent_id || 'main';
      const commandText = message.text || '';

      // Invalidate pending approvals BEFORE executing new command
      // This prevents race conditions where stale approvals could be acted upon
      try {
        const invalidateResponse = await fetch(`${RELAY_API_URL}/api/approvals/invalidate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RELAY_API_KEY}`
          },
          body: JSON.stringify({
            session_id,
            reason: 'New command execution started'
          })
        });

        if (invalidateResponse.ok) {
          const { invalidated } = await invalidateResponse.json();
          if (invalidated > 0) {
            console.log(`[daemon] Invalidated ${invalidated} pending approvals before command execution`);
          }
        }
      } catch (error) {
        console.warn(`[daemon] Failed to invalidate approvals:`, error.message);
        // Continue with execution - this is not critical
      }

      // Hybrid Execution Logic:
      // 1. Check if it's a valid whitelisted shell command
      const validation = isCommandAllowed(commandText);
      let executionResult;
      let executionType = 'shell';

      if (validation.allowed) {
        // Fast path: Execute shell command directly
        console.log(`[daemon] Executing direct shell command: ${commandText}`);
        executionResult = await executeCommand(session_id, commandText);
      } else {
        // Fallback: Natural language prompt for Claude
        console.log(`[daemon] Command not in whitelist, handing off to Claude Agent: ${commandText}`);
        executionType = 'agent';
        
        // Get session to find claude_session_id
        let session = sessions.get(session_id);

        // Fallback: Fetch from relay API if not found locally (daemon restart scenario)
        if (!session) {
          try {
            console.log(`[daemon] Session ${session_id} not found locally, fetching from relay API`);
            const response = await fetch(`${RELAY_API_URL}/api/sessions/${session_id}`, {
              headers: {
                'Authorization': `Bearer ${RELAY_API_KEY}`
              }
            });

            if (response.ok) {
              session = await response.json();
              // Re-register session locally
              sessions.set(session_id, session);
              console.log(`[daemon] Session ${session_id} recovered from relay API`);
            }
          } catch (error) {
            console.error(`[daemon] Failed to fetch session ${session_id} from relay:`, error.message);
          }
        }

        if (session) {
          // Pass the natural language prompt directly to Claude
          executionResult = await spawnClaudeProcess(session.claude_session_id || session_id, commandText);
        } else {
          executionResult = {
            success: false,
            exit_code: -1,
            stdout: '',
            stderr: '',
            error: `Session not registered and not found in relay: ${session_id}`
          };
        }
      }

      // Store execution result for context delivery to local client
      // This ensures the local Claude client sees the work done remotely
      await storeExecutionResult(
        session_id,
        message.id, // Use message ID as pseudo-approval ID
        'Remote Command',
        commandText,
        executionResult
      );

      // Build result message with execution details
      let resultText = '';
      if (executionResult.success) {
        const header = executionType === 'agent' ? 'Claude executed your request:\n\n' : 'Command executed successfully:\n\n';
        resultText = `${header}${executionResult.stdout}`;
      } else {
        const header = executionType === 'agent' ? 'Claude failed to execute request:\n\n' : `Command failed with exit code ${executionResult.exit_code}:\n\n`;
        resultText = `${header}Error: ${executionResult.error}\n\nStderr:\n${executionResult.stderr}`;
      }

      try {
        const resultResponse = await fetch(`${RELAY_API_URL}/api/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RELAY_API_KEY}`
          },
          body: JSON.stringify({
            session_id,
            text: resultText,
            meta: {
              type: 'result',
              from_agent_id: 'daemon',
              target_agent_id: replyAgentId,
              in_reply_to_message_id: message.id,
              command_exit_code: executionResult.exit_code,
              command_success: executionResult.success,
              execution_type: executionType
            }
          })
        });

        if (!resultResponse.ok) {
          const errorText = await resultResponse.text();
          console.error(`[daemon] Failed to post result message: HTTP ${resultResponse.status} - ${errorText}`);
        }
      } catch (sendError) {
        console.error('[daemon] Failed to send result message:', sendError.message);
      }
    }

    // Acknowledge the message so it is not re-delivered
    await fetch(`${RELAY_API_URL}/api/messages/${encodeURIComponent(message.id)}/ack`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RELAY_API_KEY}`
      }
    });
  } catch (error) {
    console.error('[daemon] Failed to handle inbox message:', error.message);
  }
}

/**
 * Send heartbeat for a session to keep it alive in the relay
 * @param {string} session_id - The session ID to send heartbeat for
 */
async function sendHeartbeat(session_id) {
  try {
    // Get or initialize heartbeat state for this session
    let state = heartbeatState.get(session_id);
    if (!state) {
      state = { count: 0, lastSent: 0 };
      heartbeatState.set(session_id, state);
    }

    state.count++;
    state.lastSent = Date.now();

    const response = await fetch(
      `${RELAY_API_URL}/api/sessions/${encodeURIComponent(session_id)}/heartbeat`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RELAY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timestamp: Date.now(),
          pid: process.pid,
          count: state.count
        }),
        signal: AbortSignal.timeout(5000) // 5 second timeout
      }
    );

    if (!response.ok) {
      // 404 means session not registered in mech-storage yet (registered by Claude hooks, not daemon)
      // This is expected for sessions that are only locally registered - silently skip
      if (response.status !== 404) {
        console.error(`[daemon] Heartbeat failed for session ${session_id}: ${response.status}`);
      }
    }
  } catch (error) {
    // Don't spam logs for heartbeat failures - just note it
    if (error.name !== 'AbortError') {
      console.error(`[daemon] Heartbeat error for ${session_id}: ${error.message}`);
    }
  }
}

/**
 * Relay API Polling Loop
 * Polls relay API every 5 seconds for approved requests
 */
async function pollRelayAPI() {
  if (isShuttingDown) return;

  try {
    // Fetch pending approvals and inbox messages for all registered sessions
    const TEST_SESSION_FILTER = process.env.TELEPORTATION_TEST_SESSION_FILTER;
    for (const [session_id] of sessions) {
      // Optional: Filter sessions for testing (if TEST_SESSION_FILTER env var set)
      if (TEST_SESSION_FILTER && !session_id.startsWith(TEST_SESSION_FILTER)) {
        continue;
      }
      console.log(`Polling for session ${session_id}`);

      // 1) Approvals polling (existing behavior)
      try {
        const response = await fetch(
          `${RELAY_API_URL}/api/approvals?status=allowed&session_id=${session_id}`,
          {
            headers: {
              'Authorization': `Bearer ${RELAY_API_KEY}`
            }
          }
        );

        if (!response.ok) {
          console.error(`[daemon] Failed to fetch approvals for session ${session_id}: ${response.status}`);
        } else {
          const approvals = await response.json();

          // Queue newly approved requests
          for (const approval of approvals) {
            // Skip if already queued or executed
            if (approvalQueue.find(a => a.approval_id === approval.id)) continue;
            if (executions.has(approval.id)) continue;

            // Skip if already acknowledged (already handled by hook's fast path)
            if (approval.acknowledgedAt) continue;

            approvalQueue.push({
              approval_id: approval.id,
              session_id: approval.session_id,
              tool_name: approval.tool_name,
              tool_input: approval.tool_input,
              queued_at: Date.now()
            });

            console.log(`[daemon] Approval discovered: ${approval.id} (${approval.tool_name})`);
          }
        }
      } catch (approvalError) {
        console.error(`[daemon] Approval polling error for session ${session_id}:`, approvalError.message);
      }

      // 2) Inbox polling (new behavior)
      try {
        const messageResponse = await fetch(
          `${RELAY_API_URL}/api/messages/pending?session_id=${encodeURIComponent(session_id)}&agent_id=daemon`,
          {
            headers: {
              'Authorization': `Bearer ${RELAY_API_KEY}`
            }
          }
        );

        if (!messageResponse.ok) {
          // 404 or empty is not an error; only log unexpected statuses
          if (messageResponse.status !== 404) {
            console.error(`[daemon] Failed to fetch inbox message for session ${session_id}: ${messageResponse.status}`);
          }
        } else {
          const inboxMessage = await messageResponse.json();
          const hasFields = inboxMessage && typeof inboxMessage === 'object' && inboxMessage.id && inboxMessage.text;
          if (hasFields) {
            await handleInboxMessage(session_id, inboxMessage);
          }
        }
      } catch (inboxError) {
        console.error(`[daemon] Inbox polling error for session ${session_id}:`, inboxError.message);
      }

      // 3) Heartbeat - send periodically to keep session alive
      // Only send heartbeat if enough time has passed since last one (throttled per session)
      const now = Date.now();
      const sessionHeartbeat = heartbeatState.get(session_id);
      const lastSent = sessionHeartbeat?.lastSent || 0;
      if (now - lastSent >= HEARTBEAT_INTERVAL_MS) {
        await sendHeartbeat(session_id);
      }
    }

    // Process approval queue
    await processQueue();
  } catch (error) {
    console.error(`[daemon] Polling error:`, error.message);
  }

  // Schedule next poll
  if (!isShuttingDown) {
    pollingTimer = setTimeout(pollRelayAPI, POLL_INTERVAL_MS);
  }
}

/**
 * Cleanup old executions (TTL-based)
 * Removes executions older than 1 hour to prevent memory growth
 */
function cleanupOldExecutions() {
  if (isShuttingDown) return;

  const oneHourAgo = Date.now() - CLEANUP_INTERVAL_MS;
  let removed = 0;

  for (const [id, exec] of executions) {
    // Remove completed executions older than 1 hour
    if (exec.completed_at && exec.completed_at < oneHourAgo) {
      executions.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[daemon] Cleaned up ${removed} old execution(s) from cache`);
  }

  // Clean up heartbeatState for sessions that no longer exist
  let heartbeatRemoved = 0;
  for (const sessionId of heartbeatState.keys()) {
    if (!sessions.has(sessionId)) {
      heartbeatState.delete(sessionId);
      heartbeatRemoved++;
    }
  }

  if (heartbeatRemoved > 0) {
    console.log(`[daemon] Cleaned up ${heartbeatRemoved} stale heartbeat state(s)`);
  }

  // Also enforce LRU limit if still over limit
  while (executions.size > MAX_EXECUTIONS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [id, exec] of executions) {
      if (exec.completed_at && exec.completed_at < oldestTime) {
        oldestTime = exec.completed_at;
        oldestKey = id;
      }
    }
    if (oldestKey) {
      executions.delete(oldestKey);
    } else {
      // If no completed executions, remove oldest by started_at
      for (const [id, exec] of executions) {
        if (exec.started_at < oldestTime) {
          oldestTime = exec.started_at;
          oldestKey = id;
        }
      }
      if (oldestKey) {
        executions.delete(oldestKey);
      } else {
        break; // Shouldn't happen, but safety check
      }
    }
  }
}

/**
 * Process Approval Queue
 * Execute queued approvals one at a time (FIFO)
 */
async function processQueue() {
  // Process one at a time to avoid overwhelming the system
  if (approvalQueue.length === 0) return;

  const approval = approvalQueue.shift();
  const { approval_id, session_id, tool_name, tool_input } = approval;
  const command = tool_input?.command || '';

  console.log(`[daemon] Processing approval: ${approval_id} (${tool_name})`);

  // Check if already executing (race condition prevention)
  if (executions.has(approval_id)) {
    const existing = executions.get(approval_id);
    if (existing.status === 'executing') {
      console.log(`[daemon] Approval ${approval_id} already executing, skipping duplicate`);
      return;
    }
  }

  // Enforce LRU cache limit before adding new execution
  if (executions.size >= MAX_EXECUTIONS) {
    // Remove oldest completed execution
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [id, exec] of executions) {
      if (exec.completed_at && exec.completed_at < oldestTime) {
        oldestTime = exec.completed_at;
        oldestKey = id;
      }
    }
    if (oldestKey) {
      executions.delete(oldestKey);
      console.log(`[daemon] Removed oldest execution from cache: ${oldestKey}`);
    } else {
      // If no completed executions, remove oldest by started_at
      for (const [id, exec] of executions) {
        if (exec.started_at < oldestTime) {
          oldestTime = exec.started_at;
          oldestKey = id;
        }
      }
      if (oldestKey) {
        executions.delete(oldestKey);
        console.log(`[daemon] Removed oldest execution from cache: ${oldestKey}`);
      }
    }
  }

  // Mark as executing
  executions.set(approval_id, {
    approval_id,
    status: 'executing',
    started_at: Date.now(),
    completed_at: null,
    exit_code: null,
    stdout: '',
    stderr: '',
    error: null
  });

  try {
    // Acknowledge approval BEFORE executing to prevent duplicate execution
    // if user also approves locally while daemon is executing
    try {
      await fetch(`${RELAY_API_URL}/api/approvals/${approval_id}/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_API_KEY}`
        },
        body: JSON.stringify({ processed: true })
      });
      console.log(`[daemon] Acknowledged approval: ${approval_id}`);
    } catch (ackError) {
      console.error(`[daemon] Failed to acknowledge approval:`, ackError.message);
      // Continue anyway - acknowledgment is optional
    }

    // Build prompt for tool execution
    const prompt = buildToolPrompt(tool_name, tool_input);

    // Spawn child Claude process
    const result = await spawnClaudeProcess(session_id, prompt);

    // Update execution status
    executions.set(approval_id, {
      ...executions.get(approval_id),
      status: result.success ? 'completed' : 'failed',
      completed_at: Date.now(),
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error
    });

    // Report execution status to relay API
    await reportExecutionStatus(approval_id, result);

    // Store execution result for later delivery to the user
    await storeExecutionResult(session_id, approval_id, tool_name, command, result);

    console.log(`[daemon] Approval ${approval_id} ${result.success ? 'completed' : 'failed'}`);
  } catch (error) {
    console.error(`[daemon] Execution error for approval ${approval_id}:`, error.message);

    executions.set(approval_id, {
      ...executions.get(approval_id),
      status: 'failed',
      completed_at: Date.now(),
      error: error.message
    });

    const fallbackResult = {
      success: false,
      exit_code: null,
      stdout: '',
      stderr: '',
      error: error.message,
      duration_ms: null,
      started_at: null,
      executed_at: Date.now()
    };

    // Report failure to relay API
    await reportExecutionStatus(approval_id, {
      success: false,
      error: error.message
    });

    // Store failed execution result for later delivery
    await storeExecutionResult(session_id, approval_id, tool_name, command, fallbackResult);
  }
}

/**
 * Build tool execution prompt
 * Uses structured JSON format to prevent command injection
 * Claude Code will parse this as structured input, not natural language
 */
function buildToolPrompt(tool_name, tool_input) {
  // Use structured JSON format instead of string interpolation
  // This prevents command injection by ensuring inputs are properly escaped
  const input = tool_input || {};
  
  // Return structured JSON that Claude Code can parse safely
  // This format prevents any malicious input from being interpreted as commands
  return JSON.stringify({
    tool: tool_name,
    parameters: input,
    mode: 'headless_execution',
    timestamp: Date.now()
  });
}

/**
 * Spawn child Claude Code process
 * Executes: claude --resume <session_id> -p "<prompt>"
 *
 * Security: Validates session exists and is authorized before execution
 */
async function spawnClaudeProcess(session_id, prompt) {
  // SECURITY: Validate session exists in local registry
  const session = sessions.get(session_id);
  if (!session) {
    throw new Error(`Session not registered: ${session_id}`);
  }

  console.log(`[daemon] Processing approval for session ${session_id}`);

  // SECURITY: Verify session is still active via relay API
  try {
    const sessionCheck = await fetch(`${RELAY_API_URL}/api/sessions/${session_id}/daemon-state`, {
      headers: { 'Authorization': `Bearer ${RELAY_API_KEY}` },
      signal: AbortSignal.timeout(5000)
    });

    if (!sessionCheck.ok) {
      throw new Error(`Session invalid or expired: ${session_id} (status: ${sessionCheck.status})`);
    }
  } catch (error) {
    // Log security event
    console.error(`[daemon] SECURITY: Session validation failed for ${session_id}:`, error.message);
    throw new Error(`Session validation failed: ${error.message}`);
  }

  return new Promise((resolve) => {
    const cwd = session.cwd || process.cwd();
    const startedAt = Date.now();

    // SECURITY: Defense-in-depth - validate session_id format at spawn point
    // Even though we validate at HTTP endpoints, add assertion here for safety
    if (!/^[a-zA-Z0-9_@.-]+$/.test(session_id)) {
      throw new Error('Invalid session_id format at spawn point');
    }

    // Determine execution mode
    let isToolExecution = false;
    let commandToRun = '';
    let agentPrompt = '';

    try {
      const promptObj = JSON.parse(prompt);
      if (promptObj.parameters?.command) {
        isToolExecution = true;
        commandToRun = promptObj.parameters.command;
      }
    } catch (e) {
      // Not JSON, treat as natural language prompt
    }

    if (!isToolExecution) {
      agentPrompt = prompt;
    }

    console.log(`[daemon] Spawning process (${isToolExecution ? 'Tool Shell' : 'Claude Agent'})...`);
    if (isToolExecution) {
      console.log(`[daemon] Executing tool command: ${commandToRun}`);
    } else {
      console.log(`[daemon] Executing agent prompt: ${agentPrompt}`);
    }

    let child;
    
    if (isToolExecution) {
      /**
       * MODE 1: Tool Execution (Direct Shell)
       * SECURITY: Command execution with defense-in-depth
       *
       * Security layers:
       * 1. Commands validated against whitelist (isCommandAllowed)
       * 2. Shell metacharacters blocked (sanitizeCommand) - prevents injection
       * 3. Commands are pre-validated before reaching this point
       */
      child = spawn('sh', ['-c', commandToRun], {
        cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          TELEPORTATION_DAEMON_CHILD: 'true'
        }
      });
    } else {
      /**
       * MODE 2: Agent Execution (Claude CLI)
       * Invokes Claude Code with the natural language prompt
       * Uses --resume to attach to the correct session context
       */
      // Use CLAUDE_CLI_PATH from env or default to 'claude'
      const cliBin = process.env.CLAUDE_CLI_PATH || 'claude';
      
      // Use the actual Claude session ID for resuming, not the teleportation session ID
      const resumeSessionId = session.claude_session_id || session_id;
      
      const args = [
        '--resume', resumeSessionId,
        '-p', agentPrompt,
        '--dangerously-skip-permissions' // Skip permissions for headless execution
      ];
      
      console.log(`[daemon] Invoking: ${cliBin} ${args.join(' ')}`);
      
      child = spawn(cliBin, args, {
        cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          TELEPORTATION_DAEMON_CHILD: 'true',
          // Ensure CI/non-interactive mode
          CI: 'true'
        }
      });
    }

    // Close stdin immediately to prevent hanging
    if (child.stdin) {
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Capture stdout
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout handler
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, CHILD_TIMEOUT_MS);

    // Handle process exit
    child.on('close', (code) => {
      clearTimeout(timeout);

      const executedAt = Date.now();

      resolve({
        success: code === 0 && !timedOut,
        exit_code: code,
        stdout: truncateOutput(stdout, 'STDOUT'),
        stderr: truncateOutput(stderr, 'STDERR'),
        error: timedOut ? 'Execution timed out' : null,
        duration_ms: executedAt - startedAt,
        started_at: startedAt,
        executed_at: executedAt
      });
    });

    // Handle spawn errors
    child.on('error', (err) => {
      clearTimeout(timeout);

      const executedAt = Date.now();

      resolve({
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: '',
        error: err.message,
        duration_ms: 0,
        started_at: startedAt,
        executed_at: executedAt
      });
    });
  });
}

/**
 * Store execution result in relay pending_results for later delivery
 */
async function storeExecutionResult(session_id, approval_id, tool_name, command, executionResult) {
  if (!session_id || !RELAY_API_URL || !RELAY_API_KEY) {
    return;
  }

  const payload = {
    approval_id,
    command: command || '',
    tool_name,
    exit_code: executionResult.exit_code ?? null,
    stdout: (executionResult.stdout || '').slice(0, 10_000),
    stderr: (executionResult.stderr || '').slice(0, 10_000),
    executed_at: executionResult.executed_at || Date.now()
  };

  const url = `${RELAY_API_URL}/api/sessions/${encodeURIComponent(session_id)}/results`;

  const attempt = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`[daemon] Failed to store execution result for approval ${approval_id}: HTTP ${res.status}`);
    } else {
      console.log(`[daemon] Stored execution result for approval ${approval_id} (session ${session_id})`);
    }
  };

  try {
    await attempt();
  } catch (error) {
    // Retry once on network failure
    console.error(`[daemon] Error storing execution result for approval ${approval_id}, retrying once:`, error.message);
    try {
      await attempt();
    } catch (error2) {
      console.error(`[daemon] Second attempt to store execution result failed for approval ${approval_id}:`, error2.message);
    }
  }
}

/**
 * Report execution status to relay API
 */
async function reportExecutionStatus(approval_id, result) {
  try {
    await fetch(`${RELAY_API_URL}/api/approvals/${approval_id}/executed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_API_KEY}`
      },
      body: JSON.stringify({
        success: result.success,
        exit_code: result.exit_code,
        stdout: result.stdout?.slice(0, 10_000), // Send first 10KB only
        stderr: result.stderr?.slice(0, 10_000),
        error: result.error,
        duration_ms: result.duration_ms
      })
    });
  } catch (error) {
    console.error(`[daemon] Failed to report execution status:`, error.message);
  }
}

/**
 * Cleanup function
 */
async function cleanup() {
  console.log('[daemon] Cleanup function called.');
  console.log('[daemon] Cleaning up...');
  isShuttingDown = true;

  // Stop polling
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }

  // Clear cleanup timer
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }

  // Close HTTP server
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  // Release PID lock
  await releasePidLock(process.pid);

  console.log('[daemon] Cleanup complete');
}

/**
 * Start daemon
 */
async function main() {
  console.log('[daemon] Main function started.');
  try {
    // Acquire PID lock
    await acquirePidLock(process.pid);

    // Setup signal handlers
    setupSignalHandlers(cleanup);

    // Start HTTP server (using built-in http module)
    server = http.createServer(handleRequest);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[daemon] HTTP server listening on http://127.0.0.1:${PORT}`);
      console.log(`[daemon] Relay API: ${RELAY_API_URL}`);
      console.log(`[daemon] Poll interval: ${POLL_INTERVAL_MS}ms`);
      console.log(`[daemon] PID: ${process.pid}`);
    });

    // Start polling loop
    console.log('[daemon] Starting relay API polling...');
    pollRelayAPI();

    // Start cleanup interval for old executions
    cleanupTimer = setInterval(cleanupOldExecutions, CLEANUP_INTERVAL_MS);
    console.log(`[daemon] Cleanup interval: ${CLEANUP_INTERVAL_MS / 1000}s`);

    idleTimer = setInterval(() => {
      checkIdleTimeout().catch((err) => {
        console.error('[daemon] Idle timeout check failed:', err.message);
      });
    }, IDLE_CHECK_INTERVAL_MS);
    console.log(`[daemon] Idle timeout: ${IDLE_TIMEOUT_MS / 60000}m, check interval: ${IDLE_CHECK_INTERVAL_MS / 1000}s`);
  } catch (error) {
    console.error('[daemon] Failed to start:', error.message);
    process.exit(1);
  }
}

// Start daemon if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

const __test = {
  hasIdleTimedOut,
  checkIdleTimeout,
  _getLastSessionActivityAt: () => lastSessionActivityAt,
  _setLastSessionActivityAt: (value) => {
    lastSessionActivityAt = value;
  },
  _getSessionsMap: () => sessions
};

export {
  main,
  cleanup,
  buildToolPrompt,
  spawnClaudeProcess,
  pollRelayAPI,
  processQueue,
  storeExecutionResult,
  hasIdleTimedOut,
  validateSessionId,
  validateApprovalId,
  validateToolName,
  parseJSONBody,
  cleanupOldExecutions,
  executeCommand,
  handleInboxMessage,
  MAX_EXECUTIONS,
  __test
};
