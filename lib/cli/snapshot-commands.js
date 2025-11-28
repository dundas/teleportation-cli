#!/usr/bin/env node
/**
 * CLI Commands for Snapshot Management
 */

import {
  createSnapshot,
  restoreSnapshot,
  listSnapshots,
  deleteSnapshot,
  deleteAllSnapshots,
  getSnapshotDiff,
  SnapshotType
} from '../snapshot/manager.js';
import { getCurrentSessionId } from '../worktree/manager.js';

/**
 * Create a snapshot
 */
export async function commandSnapshotCreate(args) {
  const {
    sessionId,
    type = SnapshotType.CHECKPOINT,
    message = ''
  } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to create snapshot for a specific session.');
      }
    }

    console.log(`Creating ${type} snapshot for session: ${targetSessionId}`);
    if (message) {
      console.log(`Message: ${message}`);
    }

    const snapshot = await createSnapshot(targetSessionId, type, message);

    console.log(`✓ Snapshot created: ${snapshot.id}`);
    console.log(`  Type: ${snapshot.type}`);
    console.log(`  Branch: ${snapshot.branch}`);
    console.log(`  Commit: ${snapshot.commitHash.substring(0, 8)}`);
    console.log(`  Timestamp: ${new Date(snapshot.timestamp).toLocaleString()}`);

    if (snapshot.stashRef) {
      console.log(`  Stash: ${snapshot.stashRef}`);
    }

    return snapshot;
  } catch (error) {
    console.error(`Failed to create snapshot: ${error.message}`);
    throw error;
  }
}

/**
 * List snapshots
 */
export async function commandSnapshotList(args) {
  const { sessionId } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to list snapshots for a specific session.');
      }
    }

    const snapshots = await listSnapshots(targetSessionId);

    if (snapshots.length === 0) {
      console.log(`No snapshots found for session: ${targetSessionId}`);
      return;
    }

    console.log(`\nSnapshots for session: ${targetSessionId}\n`);
    console.log('ID'.padEnd(50), 'TYPE'.padEnd(15), 'DATE'.padEnd(25), 'MESSAGE');
    console.log('-'.repeat(120));

    for (const snapshot of snapshots) {
      const date = new Date(snapshot.timestamp).toLocaleString();
      const msg = snapshot.message || '(no message)';
      console.log(
        snapshot.id.padEnd(50),
        snapshot.type.padEnd(15),
        date.padEnd(25),
        msg.substring(0, 30)
      );
    }

    return snapshots;
  } catch (error) {
    console.error(`Failed to list snapshots: ${error.message}`);
    throw error;
  }
}

/**
 * Restore a snapshot
 */
export async function commandSnapshotRestore(args) {
  const { snapshotId, force = false } = args;

  if (!snapshotId) {
    throw new Error('Snapshot ID is required (--snapshot-id or -s)');
  }

  try {
    console.log(`Restoring snapshot: ${snapshotId}`);

    if (!force) {
      console.log('WARNING: This will overwrite your current working directory.');
      console.log('Use --force to confirm.');
      return false;
    }

    await restoreSnapshot(snapshotId, force);

    console.log(`✓ Snapshot restored: ${snapshotId}`);
    console.log('Your working directory has been restored to the snapshot state.');

    return true;
  } catch (error) {
    console.error(`Failed to restore snapshot: ${error.message}`);
    throw error;
  }
}

/**
 * Show diff between current state and snapshot
 */
export async function commandSnapshotDiff(args) {
  const { snapshotId } = args;

  if (!snapshotId) {
    throw new Error('Snapshot ID is required (--snapshot-id or -s)');
  }

  try {
    const diff = await getSnapshotDiff(snapshotId);

    if (!diff || diff.trim().length === 0) {
      console.log('No differences found.');
      return '';
    }

    console.log(diff);
    return diff;
  } catch (error) {
    console.error(`Failed to get snapshot diff: ${error.message}`);
    throw error;
  }
}

/**
 * Delete a snapshot
 */
export async function commandSnapshotDelete(args) {
  const { snapshotId, force = false } = args;

  if (!snapshotId) {
    throw new Error('Snapshot ID is required (--snapshot-id or -s)');
  }

  try {
    if (!force) {
      console.log(`This will permanently delete snapshot: ${snapshotId}`);
      console.log('Use --force to confirm.');
      return false;
    }

    await deleteSnapshot(snapshotId);
    console.log(`✓ Snapshot deleted: ${snapshotId}`);

    return true;
  } catch (error) {
    console.error(`Failed to delete snapshot: ${error.message}`);
    throw error;
  }
}

/**
 * Delete all snapshots for a session
 */
export async function commandSnapshotDeleteAll(args) {
  const { sessionId, force = false } = args;

  try {
    let targetSessionId = sessionId;

    // If no session ID, try to get current
    if (!targetSessionId) {
      targetSessionId = getCurrentSessionId();
      if (!targetSessionId) {
        throw new Error('Not in a worktree. Specify --session-id to delete snapshots for a specific session.');
      }
    }

    if (!force) {
      console.log(`This will permanently delete ALL snapshots for session: ${targetSessionId}`);
      console.log('Use --force to confirm.');
      return false;
    }

    const count = await deleteAllSnapshots(targetSessionId);
    console.log(`✓ Deleted ${count} snapshot(s)`);

    return count;
  } catch (error) {
    console.error(`Failed to delete snapshots: ${error.message}`);
    throw error;
  }
}
