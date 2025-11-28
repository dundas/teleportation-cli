#!/usr/bin/env node
/**
 * Session Registry Module
 * Tracks active coding sessions, their worktrees, and potential conflicts
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getRepoRoot } from '../worktree/manager.js';

const REGISTRY_DIR = join(homedir(), '.teleportation', 'session-registry');
const REGISTRY_FILE = join(REGISTRY_DIR, 'sessions.json');

/**
 * Session entry structure
 * @typedef {Object} SessionEntry
 * @property {string} id - Session ID
 * @property {string} agent - Agent type (claude-code, windsurf, cursor, etc.)
 * @property {string} worktreePath - Path to worktree
 * @property {string} branch - Branch name
 * @property {string} repoRoot - Repository root path
 * @property {number} startedAt - Timestamp when session started
 * @property {number} lastActiveAt - Last activity timestamp
 * @property {string} status - Session status (active, paused, completed)
 * @property {Array<string>} modifiedFiles - List of modified files
 */

/**
 * Load the session registry
 * @returns {Promise<Array<SessionEntry>>}
 */
async function loadRegistry() {
  await mkdir(REGISTRY_DIR, { recursive: true });

  if (!existsSync(REGISTRY_FILE)) {
    return [];
  }

  try {
    const content = await readFile(REGISTRY_FILE, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load registry: ${error.message}`);
    return [];
  }
}

/**
 * Save the session registry
 * @param {Array<SessionEntry>} sessions
 * @returns {Promise<void>}
 */
async function saveRegistry(sessions) {
  await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  await writeFile(REGISTRY_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

/**
 * Register a new session
 * @param {string} sessionId - Unique session identifier
 * @param {string} agent - Agent type
 * @param {string} worktreePath - Path to worktree
 * @param {string} branch - Branch name
 * @returns {Promise<SessionEntry>}
 */
export async function registerSession(sessionId, agent, worktreePath, branch) {
  const sessions = await loadRegistry();

  // Check if session already exists
  const existing = sessions.find(s => s.id === sessionId);
  if (existing) {
    throw new Error(`Session ${sessionId} is already registered`);
  }

  const repoRoot = getRepoRoot();
  const session = {
    id: sessionId,
    agent,
    worktreePath,
    branch,
    repoRoot,
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    status: 'active',
    modifiedFiles: []
  };

  sessions.push(session);
  await saveRegistry(sessions);

  return session;
}

/**
 * Update session activity
 * @param {string} sessionId - Session identifier
 * @param {Array<string>} modifiedFiles - Optional list of modified files
 * @returns {Promise<void>}
 */
export async function updateSessionActivity(sessionId, modifiedFiles = null) {
  const sessions = await loadRegistry();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.lastActiveAt = Date.now();
  if (modifiedFiles !== null) {
    session.modifiedFiles = modifiedFiles;
  }

  await saveRegistry(sessions);
}

/**
 * Mark session as completed
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function completeSession(sessionId) {
  const sessions = await loadRegistry();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.status = 'completed';
  session.lastActiveAt = Date.now();

  await saveRegistry(sessions);
}

/**
 * Pause a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function pauseSession(sessionId) {
  const sessions = await loadRegistry();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.status = 'paused';
  session.lastActiveAt = Date.now();

  await saveRegistry(sessions);
}

/**
 * Resume a paused session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function resumeSession(sessionId) {
  const sessions = await loadRegistry();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  session.status = 'active';
  session.lastActiveAt = Date.now();

  await saveRegistry(sessions);
}

/**
 * Remove a session from the registry
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function unregisterSession(sessionId) {
  const sessions = await loadRegistry();
  const filtered = sessions.filter(s => s.id !== sessionId);

  if (filtered.length === sessions.length) {
    throw new Error(`Session ${sessionId} not found`);
  }

  await saveRegistry(filtered);
}

/**
 * List all sessions
 * @param {string} status - Optional status filter
 * @returns {Promise<Array<SessionEntry>>}
 */
export async function listSessions(status = null) {
  const sessions = await loadRegistry();

  if (status) {
    return sessions.filter(s => s.status === status);
  }

  return sessions;
}

/**
 * Get session by ID
 * @param {string} sessionId - Session identifier
 * @returns {Promise<SessionEntry|null>}
 */
export async function getSession(sessionId) {
  const sessions = await loadRegistry();
  return sessions.find(s => s.id === sessionId) || null;
}

/**
 * Get active sessions in the current repository
 * @returns {Promise<Array<SessionEntry>>}
 */
export async function getActiveSessionsInRepo() {
  const repoRoot = getRepoRoot();
  const sessions = await loadRegistry();

  return sessions.filter(s => s.repoRoot === repoRoot && s.status === 'active');
}

/**
 * Detect potential conflicts between sessions
 * @param {string} sessionId - Session identifier to check
 * @returns {Promise<Array<{sessionId: string, conflictingFiles: Array<string>}>>}
 */
export async function detectConflicts(sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const activeSessions = await getActiveSessionsInRepo();
  const conflicts = [];

  for (const other of activeSessions) {
    if (other.id === sessionId) {
      continue;
    }

    // Check for overlapping modified files
    const conflictingFiles = session.modifiedFiles.filter(file =>
      other.modifiedFiles.includes(file)
    );

    if (conflictingFiles.length > 0) {
      conflicts.push({
        sessionId: other.id,
        agent: other.agent,
        branch: other.branch,
        conflictingFiles
      });
    }
  }

  return conflicts;
}

/**
 * Clean up stale sessions (inactive for > 24 hours)
 * @returns {Promise<number>} Number of sessions cleaned up
 */
export async function cleanupStaleSessions() {
  const sessions = await loadRegistry();
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

  const active = sessions.filter(s => {
    // Keep completed sessions and recently active ones
    if (s.status === 'completed') {
      return s.lastActiveAt > oneDayAgo;
    }
    return s.lastActiveAt > oneDayAgo;
  });

  const removed = sessions.length - active.length;

  if (removed > 0) {
    await saveRegistry(active);
  }

  return removed;
}

/**
 * Get session statistics
 * @returns {Promise<{total: number, active: number, paused: number, completed: number}>}
 */
export async function getSessionStats() {
  const sessions = await loadRegistry();

  return {
    total: sessions.length,
    active: sessions.filter(s => s.status === 'active').length,
    paused: sessions.filter(s => s.status === 'paused').length,
    completed: sessions.filter(s => s.status === 'completed').length
  };
}
