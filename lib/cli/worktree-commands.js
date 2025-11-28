#!/usr/bin/env node
/**
 * CLI Commands for Worktree Management
 */

import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  listSessionWorktrees,
  getWorktreeInfo,
  pruneWorktrees,
  getCurrentSessionId,
  isInWorktree
} from '../worktree/manager.js';
import {
  registerSession,
  unregisterSession,
  getSession,
  getActiveSessionsInRepo
} from '../session-registry/manager.js';
import { createSnapshot, SnapshotType } from '../snapshot/manager.js';

/**
 * Create a new worktree for a session
 */
export async function commandWorktreeCreate(args) {
  const { sessionId, branch, agent = 'claude-code', base = 'main' } = args;

  if (!sessionId) {
    throw new Error('Session ID is required (--session-id or -s)');
  }

  if (!branch) {
    throw new Error('Branch name is required (--branch or -b)');
  }

  try {
    console.log(`Creating worktree for session: ${sessionId}`);
    console.log(`Branch: ${branch}`);
    console.log(`Base: ${base}`);

    // Create the worktree
    const worktree = await createWorktree(sessionId, branch, base);
    console.log(`✓ Worktree created at: ${worktree.path}`);

    // Register the session
    await registerSession(sessionId, agent, worktree.path, branch);
    console.log(`✓ Session registered`);

    // Create baseline snapshot
    const snapshot = await createSnapshot(
      sessionId,
      SnapshotType.BASELINE,
      'Initial baseline snapshot'
    );
    console.log(`✓ Baseline snapshot created: ${snapshot.id}`);

    console.log(`\nTo switch to this worktree:`);
    console.log(`  cd ${worktree.path}`);

    return worktree;
  } catch (error) {
    console.error(`Failed to create worktree: ${error.message}`);
    throw error;
  }
}

/**
 * List all worktrees
 */
export async function commandWorktreeList() {
  try {
    const sessionWorktrees = await listSessionWorktrees();

    if (sessionWorktrees.length === 0) {
      console.log('No session worktrees found.');
      return;
    }

    console.log('\nSession Worktrees:\n');
    console.log('SESSION ID'.padEnd(30), 'BRANCH'.padEnd(30), 'PATH');
    console.log('-'.repeat(90));

    for (const wt of sessionWorktrees) {
      console.log(
        wt.sessionId.padEnd(30),
        wt.branch.padEnd(30),
        wt.path
      );
    }

    // Show current worktree if we're in one
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId) {
      console.log(`\n→ Current session: ${currentSessionId}`);
    }

    return sessionWorktrees;
  } catch (error) {
    console.error(`Failed to list worktrees: ${error.message}`);
    throw error;
  }
}

/**
 * Remove a worktree
 */
export async function commandWorktreeRemove(args) {
  const { sessionId, force = false, keepSnapshot = true } = args;

  if (!sessionId) {
    throw new Error('Session ID is required (--session-id or -s)');
  }

  try {
    const sessionWorktrees = await listSessionWorktrees();
    const worktree = sessionWorktrees.find(wt => wt.sessionId === sessionId);

    if (!worktree) {
      throw new Error(`No worktree found for session: ${sessionId}`);
    }

    // Create pre-destroy snapshot if requested
    if (keepSnapshot) {
      console.log('Creating pre-destroy snapshot...');
      const snapshot = await createSnapshot(
        sessionId,
        SnapshotType.PRE_DESTROY,
        'Snapshot before worktree destruction'
      );
      console.log(`✓ Snapshot created: ${snapshot.id}`);
    }

    // Remove the worktree
    console.log(`Removing worktree: ${worktree.path}`);
    await removeWorktree(worktree.path, force);
    console.log('✓ Worktree removed');

    // Unregister the session
    await unregisterSession(sessionId);
    console.log('✓ Session unregistered');

    return true;
  } catch (error) {
    console.error(`Failed to remove worktree: ${error.message}`);
    throw error;
  }
}

/**
 * Show worktree information
 */
export async function commandWorktreeInfo(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID provided, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to get info for a specific session.');
      }
    }

    // Get worktree info
    const sessionWorktrees = await listSessionWorktrees();
    const worktree = sessionWorktrees.find(wt => wt.sessionId === targetSessionId);

    if (!worktree) {
      throw new Error(`No worktree found for session: ${targetSessionId}`);
    }

    // Get session info
    const session = await getSession(targetSessionId);

    console.log('\nWorktree Information:\n');
    console.log(`Session ID:    ${targetSessionId}`);
    console.log(`Agent:         ${session?.agent || 'unknown'}`);
    console.log(`Branch:        ${worktree.branch}`);
    console.log(`Path:          ${worktree.path}`);
    console.log(`Commit:        ${worktree.commitHash}`);
    console.log(`Status:        ${session?.status || 'unknown'}`);

    if (session) {
      console.log(`Started:       ${new Date(session.startedAt).toLocaleString()}`);
      console.log(`Last Active:   ${new Date(session.lastActiveAt).toLocaleString()}`);

      if (session.modifiedFiles.length > 0) {
        console.log(`\nModified Files (${session.modifiedFiles.length}):`);
        session.modifiedFiles.slice(0, 10).forEach(file => {
          console.log(`  - ${file}`);
        });
        if (session.modifiedFiles.length > 10) {
          console.log(`  ... and ${session.modifiedFiles.length - 10} more`);
        }
      }
    }

    return { worktree, session };
  } catch (error) {
    console.error(`Failed to get worktree info: ${error.message}`);
    throw error;
  }
}

/**
 * Merge worktree back to main
 */
export async function commandWorktreeMerge(args) {
  const { sessionId, target = 'main', deleteAfter = false } = args;

  if (!sessionId) {
    throw new Error('Session ID is required (--session-id or -s)');
  }

  try {
    const sessionWorktrees = await listSessionWorktrees();
    const worktree = sessionWorktrees.find(wt => wt.sessionId === sessionId);

    if (!worktree) {
      throw new Error(`No worktree found for session: ${sessionId}`);
    }

    console.log(`Merging ${worktree.branch} into ${target}...`);
    console.log('This will:');
    console.log(`  1. Switch to ${target}`);
    console.log(`  2. Pull latest changes`);
    console.log(`  3. Merge ${worktree.branch}`);
    console.log(`  4. Push to remote`);

    if (deleteAfter) {
      console.log(`  5. Delete worktree for ${sessionId}`);
    }

    console.log('\nThis operation is not yet implemented.');
    console.log('Please merge manually using git commands.');

    return false;
  } catch (error) {
    console.error(`Failed to merge worktree: ${error.message}`);
    throw error;
  }
}

/**
 * Prune stale worktrees
 */
export async function commandWorktreePrune() {
  try {
    console.log('Pruning stale worktree references...');
    pruneWorktrees();
    console.log('✓ Worktrees pruned');

    return true;
  } catch (error) {
    console.error(`Failed to prune worktrees: ${error.message}`);
    throw error;
  }
}

/**
 * Switch to a worktree
 */
export async function commandWorktreeUse(args) {
  const { sessionId } = args;

  if (!sessionId) {
    throw new Error('Session ID is required (--session-id or -s)');
  }

  try {
    const sessionWorktrees = await listSessionWorktrees();
    const worktree = sessionWorktrees.find(wt => wt.sessionId === sessionId);

    if (!worktree) {
      throw new Error(`No worktree found for session: ${sessionId}`);
    }

    console.log(`\nTo switch to this worktree, run:`);
    console.log(`  cd ${worktree.path}`);
    console.log(`\nOr use your shell's cd command directly.`);

    return worktree;
  } catch (error) {
    console.error(`Failed to switch worktree: ${error.message}`);
    throw error;
  }
}
