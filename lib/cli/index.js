#!/usr/bin/env node
/**
 * CLI Commands Index
 * Exports all snapshot/worktree/session commands for integration with teleportation-cli.cjs
 */

// Worktree commands - import for local use
import {
  commandWorktreeCreate,
  commandWorktreeList,
  commandWorktreeRemove,
  commandWorktreeInfo,
  commandWorktreeMerge,
  commandWorktreePrune,
  commandWorktreeUse
} from './worktree-commands.js';

// Snapshot commands - import for local use
import {
  commandSnapshotCreate,
  commandSnapshotList,
  commandSnapshotRestore,
  commandSnapshotDiff,
  commandSnapshotDelete,
  commandSnapshotDeleteAll
} from './snapshot-commands.js';

// Session commands - import for local use
import {
  commandSessionList,
  commandSessionInfo,
  commandCheckConflicts,
  commandSessionStats,
  commandSessionPause,
  commandSessionResume,
  commandSessionComplete,
  commandSessionCleanup
} from './session-commands.js';

// Re-export all commands
export {
  commandWorktreeCreate,
  commandWorktreeList,
  commandWorktreeRemove,
  commandWorktreeInfo,
  commandWorktreeMerge,
  commandWorktreePrune,
  commandWorktreeUse,
  commandSnapshotCreate,
  commandSnapshotList,
  commandSnapshotRestore,
  commandSnapshotDiff,
  commandSnapshotDelete,
  commandSnapshotDeleteAll,
  commandSessionList,
  commandSessionInfo,
  commandCheckConflicts,
  commandSessionStats,
  commandSessionPause,
  commandSessionResume,
  commandSessionComplete,
  commandSessionCleanup
};

// Re-export types
export { SnapshotType } from '../snapshot/manager.js';

/**
 * Parse CLI arguments for worktree/snapshot commands
 * @param {Array<string>} args - Command line arguments
 * @returns {Object} Parsed arguments
 */
export function parseArgs(args) {
  const parsed = {
    command: null,
    subcommand: null,
    sessionId: null,
    snapshotId: null,
    branch: null,
    agent: 'claude-code',
    base: 'main',
    target: 'main',
    type: 'checkpoint',
    message: '',
    force: false,
    keepSnapshot: true,
    repoOnly: false,
    status: null,
    deleteAfter: false
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === 'worktree' || arg === 'snapshot' || arg === 'session') {
      parsed.command = arg;
    } else if (arg === 'create' || arg === 'list' || arg === 'remove' ||
               arg === 'info' || arg === 'merge' || arg === 'prune' ||
               arg === 'use' || arg === 'restore' || arg === 'diff' ||
               arg === 'delete' || arg === 'delete-all' || arg === 'stats' ||
               arg === 'pause' || arg === 'resume' || arg === 'complete' ||
               arg === 'cleanup' || arg === 'check-conflicts') {
      parsed.subcommand = arg;
    } else if (arg === '--session-id' || arg === '-s') {
      parsed.sessionId = args[++i];
    } else if (arg === '--snapshot-id') {
      parsed.snapshotId = args[++i];
    } else if (arg === '--branch' || arg === '-b') {
      parsed.branch = args[++i];
    } else if (arg === '--agent' || arg === '-a') {
      parsed.agent = args[++i];
    } else if (arg === '--base') {
      parsed.base = args[++i];
    } else if (arg === '--target') {
      parsed.target = args[++i];
    } else if (arg === '--type' || arg === '-t') {
      parsed.type = args[++i];
    } else if (arg === '--message' || arg === '-m') {
      parsed.message = args[++i];
    } else if (arg === '--force' || arg === '-f') {
      parsed.force = true;
    } else if (arg === '--no-snapshot') {
      parsed.keepSnapshot = false;
    } else if (arg === '--repo-only') {
      parsed.repoOnly = true;
    } else if (arg === '--status') {
      parsed.status = args[++i];
    } else if (arg === '--delete-after') {
      parsed.deleteAfter = true;
    }

    i++;
  }

  return parsed;
}

/**
 * Route to the appropriate command handler
 * @param {Object} parsed - Parsed arguments
 * @returns {Promise<any>}
 */
export async function routeCommand(parsed) {
  const { command, subcommand } = parsed;

  if (command === 'worktree') {
    switch (subcommand) {
      case 'create':
        return commandWorktreeCreate(parsed);
      case 'list':
        return commandWorktreeList();
      case 'remove':
        return commandWorktreeRemove(parsed);
      case 'info':
        return commandWorktreeInfo(parsed);
      case 'merge':
        return commandWorktreeMerge(parsed);
      case 'prune':
        return commandWorktreePrune();
      case 'use':
        return commandWorktreeUse(parsed);
      default:
        console.log('Unknown worktree subcommand. Available: create, list, remove, info, merge, prune, use');
        return;
    }
  }

  if (command === 'snapshot') {
    switch (subcommand) {
      case 'create':
        return commandSnapshotCreate(parsed);
      case 'list':
        return commandSnapshotList(parsed);
      case 'restore':
        return commandSnapshotRestore(parsed);
      case 'diff':
        return commandSnapshotDiff(parsed);
      case 'delete':
        return commandSnapshotDelete(parsed);
      case 'delete-all':
        return commandSnapshotDeleteAll(parsed);
      default:
        console.log('Unknown snapshot subcommand. Available: create, list, restore, diff, delete, delete-all');
        return;
    }
  }

  if (command === 'session') {
    switch (subcommand) {
      case 'list':
        return commandSessionList(parsed);
      case 'info':
        return commandSessionInfo(parsed);
      case 'check-conflicts':
        return commandCheckConflicts(parsed);
      case 'stats':
        return commandSessionStats();
      case 'pause':
        return commandSessionPause(parsed);
      case 'resume':
        return commandSessionResume(parsed);
      case 'complete':
        return commandSessionComplete(parsed);
      case 'cleanup':
        return commandSessionCleanup();
      default:
        console.log('Unknown session subcommand. Available: list, info, check-conflicts, stats, pause, resume, complete, cleanup');
        return;
    }
  }

  console.log('Unknown command. Available: worktree, snapshot, session');
}

/**
 * Print help for worktree/snapshot/session commands
 */
export function printHelp() {
  console.log(`
Teleportation Worktree, Snapshot & Session Commands

WORKTREE COMMANDS:
  worktree create -s <session-id> -b <branch> [--agent <agent>] [--base <base-branch>]
    Create a new worktree for isolated session development

  worktree list
    List all session worktrees

  worktree remove -s <session-id> [--force] [--no-snapshot]
    Remove a worktree (creates pre-destroy snapshot by default)

  worktree info [-s <session-id>]
    Show information about a worktree

  worktree use -s <session-id>
    Show path to switch to a worktree

  worktree merge -s <session-id> [--target <branch>] [--delete-after]
    Merge a worktree branch (manual process guidance)

  worktree prune
    Clean up stale worktree references

SNAPSHOT COMMANDS:
  snapshot create [-s <session-id>] [-t <type>] [-m <message>]
    Create a snapshot (types: baseline, checkpoint, pre-merge, pre-commit, auto, pre-destroy)

  snapshot list [-s <session-id>]
    List all snapshots for a session

  snapshot restore --snapshot-id <id> [--force]
    Restore a previous snapshot

  snapshot diff --snapshot-id <id>
    Show diff between current state and snapshot

  snapshot delete --snapshot-id <id> [--force]
    Delete a snapshot

  snapshot delete-all [-s <session-id>] [--force]
    Delete all snapshots for a session

SESSION COMMANDS:
  session list [--status <status>] [--repo-only]
    List all registered sessions

  session info [-s <session-id>]
    Show detailed session information

  session check-conflicts [-s <session-id>]
    Check for file conflicts with other active sessions

  session stats
    Show session statistics

  session pause [-s <session-id>]
    Pause a session

  session resume [-s <session-id>]
    Resume a paused session

  session complete [-s <session-id>]
    Mark a session as completed

  session cleanup
    Clean up stale sessions (inactive > 24h)

OPTIONS:
  -s, --session-id <id>    Session identifier
  -b, --branch <name>      Branch name
  -a, --agent <type>       Agent type (default: claude-code)
  -t, --type <type>        Snapshot type
  -m, --message <msg>      Snapshot message
  -f, --force              Force operation
  --base <branch>          Base branch for new worktree (default: main)
  --target <branch>        Target branch for merge (default: main)
  --no-snapshot            Skip creating snapshot before destructive ops
  --repo-only              Only show sessions for current repository
  --status <status>        Filter by status (active, paused, completed)
  --delete-after           Delete worktree after merge
`);
}
