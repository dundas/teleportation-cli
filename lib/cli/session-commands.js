#!/usr/bin/env node
/**
 * CLI Commands for Session Registry Management
 */

import {
  listSessions,
  getSession,
  getActiveSessionsInRepo,
  detectConflicts,
  cleanupStaleSessions,
  getSessionStats,
  completeSession,
  pauseSession,
  resumeSession
} from '../session-registry/manager.js';
import { getCurrentSessionId } from '../worktree/manager.js';

/**
 * List all sessions
 */
export async function commandSessionList(args) {
  const { status, repoOnly = false } = args;

  try {
    let sessions;

    if (repoOnly) {
      sessions = await getActiveSessionsInRepo();
    } else {
      sessions = await listSessions(status);
    }

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }

    console.log('\nRegistered Sessions:\n');
    console.log(
      'SESSION ID'.padEnd(25),
      'AGENT'.padEnd(15),
      'BRANCH'.padEnd(25),
      'STATUS'.padEnd(12),
      'LAST ACTIVE'
    );
    console.log('-'.repeat(100));

    for (const session of sessions) {
      const lastActive = new Date(session.lastActiveAt).toLocaleString();
      console.log(
        session.id.padEnd(25),
        session.agent.padEnd(15),
        session.branch.padEnd(25),
        session.status.padEnd(12),
        lastActive
      );
    }

    // Show current session if we're in one
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId) {
      console.log(`\n→ Current session: ${currentSessionId}`);
    }

    return sessions;
  } catch (error) {
    console.error(`Failed to list sessions: ${error.message}`);
    throw error;
  }
}

/**
 * Show session details
 */
export async function commandSessionInfo(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to get info for a specific session.');
      }
    }

    const session = await getSession(targetSessionId);

    if (!session) {
      throw new Error(`Session not found: ${targetSessionId}`);
    }

    console.log('\nSession Information:\n');
    console.log(`Session ID:    ${session.id}`);
    console.log(`Agent:         ${session.agent}`);
    console.log(`Branch:        ${session.branch}`);
    console.log(`Worktree:      ${session.worktreePath}`);
    console.log(`Repository:    ${session.repoRoot}`);
    console.log(`Status:        ${session.status}`);
    console.log(`Started:       ${new Date(session.startedAt).toLocaleString()}`);
    console.log(`Last Active:   ${new Date(session.lastActiveAt).toLocaleString()}`);

    if (session.modifiedFiles.length > 0) {
      console.log(`\nModified Files (${session.modifiedFiles.length}):`);
      session.modifiedFiles.slice(0, 15).forEach(file => {
        console.log(`  - ${file}`);
      });
      if (session.modifiedFiles.length > 15) {
        console.log(`  ... and ${session.modifiedFiles.length - 15} more`);
      }
    } else {
      console.log('\nNo modified files tracked.');
    }

    return session;
  } catch (error) {
    console.error(`Failed to get session info: ${error.message}`);
    throw error;
  }
}

/**
 * Check for conflicts between sessions
 */
export async function commandCheckConflicts(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to check conflicts for a specific session.');
      }
    }

    console.log(`Checking for conflicts with session: ${targetSessionId}\n`);

    const conflicts = await detectConflicts(targetSessionId);

    if (conflicts.length === 0) {
      console.log('✓ No conflicts detected with other active sessions.');
      return [];
    }

    console.log(`⚠ Found conflicts with ${conflicts.length} other session(s):\n`);

    for (const conflict of conflicts) {
      console.log(`Session: ${conflict.sessionId}`);
      console.log(`  Agent: ${conflict.agent}`);
      console.log(`  Branch: ${conflict.branch}`);
      console.log(`  Conflicting files:`);
      conflict.conflictingFiles.forEach(file => {
        console.log(`    - ${file}`);
      });
      console.log();
    }

    console.log('Recommendation: Coordinate with other sessions before merging.');
    console.log('Consider creating a snapshot before proceeding with any merges.');

    return conflicts;
  } catch (error) {
    console.error(`Failed to check conflicts: ${error.message}`);
    throw error;
  }
}

/**
 * Show session statistics
 */
export async function commandSessionStats() {
  try {
    const stats = await getSessionStats();

    console.log('\nSession Statistics:\n');
    console.log(`Total Sessions:     ${stats.total}`);
    console.log(`Active:             ${stats.active}`);
    console.log(`Paused:             ${stats.paused}`);
    console.log(`Completed:          ${stats.completed}`);

    return stats;
  } catch (error) {
    console.error(`Failed to get session stats: ${error.message}`);
    throw error;
  }
}

/**
 * Pause a session
 */
export async function commandSessionPause(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to pause a specific session.');
      }
    }

    await pauseSession(targetSessionId);
    console.log(`✓ Session paused: ${targetSessionId}`);

    return true;
  } catch (error) {
    console.error(`Failed to pause session: ${error.message}`);
    throw error;
  }
}

/**
 * Resume a session
 */
export async function commandSessionResume(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to resume a specific session.');
      }
    }

    await resumeSession(targetSessionId);
    console.log(`✓ Session resumed: ${targetSessionId}`);

    return true;
  } catch (error) {
    console.error(`Failed to resume session: ${error.message}`);
    throw error;
  }
}

/**
 * Complete a session
 */
export async function commandSessionComplete(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to complete a specific session.');
      }
    }

    await completeSession(targetSessionId);
    console.log(`✓ Session marked as completed: ${targetSessionId}`);

    return true;
  } catch (error) {
    console.error(`Failed to complete session: ${error.message}`);
    throw error;
  }
}

/**
 * Clean up stale sessions
 */
export async function commandSessionCleanup() {
  try {
    console.log('Cleaning up stale sessions...');
    const count = await cleanupStaleSessions();

    if (count === 0) {
      console.log('No stale sessions found.');
    } else {
      console.log(`✓ Cleaned up ${count} stale session(s)`);
    }

    return count;
  } catch (error) {
    console.error(`Failed to cleanup sessions: ${error.message}`);
    throw error;
  }
}
