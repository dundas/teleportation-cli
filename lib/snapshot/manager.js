#!/usr/bin/env node
/**
 * Snapshot Management Module
 * Handles creation, restoration, and management of code snapshots
 */

import { execSync } from 'child_process';
import { join, resolve, basename } from 'path';
import { mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { getRepoRoot, validateSessionId } from '../worktree/manager.js';

const SNAPSHOT_BASE = '.teleportation/snapshots';

// Validation pattern for snapshot IDs (session-type-timestamp format)
const VALID_SNAPSHOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}-[a-z-]+-\d+$/;

/**
 * Validate a snapshot ID format
 * @param {string} snapshotId - Snapshot ID to validate
 * @returns {string} Validated snapshot ID
 * @throws {Error} If snapshot ID is invalid
 */
function validateSnapshotId(snapshotId) {
  if (!snapshotId || typeof snapshotId !== 'string') {
    throw new Error('Snapshot ID is required');
  }
  if (!VALID_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error(
      `Invalid snapshot ID format: "${snapshotId}". Expected format: sessionId-type-timestamp`
    );
  }
  return snapshotId;
}

/**
 * Validate a commit hash (SHA-1 or abbreviated)
 * @param {string} commitHash - Commit hash to validate
 * @returns {string} Validated commit hash
 * @throws {Error} If commit hash is invalid
 */
function validateCommitHash(commitHash) {
  if (!commitHash || typeof commitHash !== 'string') {
    throw new Error('Commit hash is required');
  }
  // SHA-1 hashes are 40 hex chars, but abbreviated can be 7+
  if (!/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    throw new Error(`Invalid commit hash: "${commitHash}"`);
  }
  return commitHash;
}

/**
 * Validate a stash reference
 * @param {string} stashRef - Stash reference to validate
 * @returns {string} Validated stash reference
 * @throws {Error} If stash reference is invalid
 */
function validateStashRef(stashRef) {
  if (!stashRef || typeof stashRef !== 'string') {
    throw new Error('Stash reference is required');
  }
  // stash@{n} format
  if (!/^stash@\{\d+\}$/.test(stashRef)) {
    throw new Error(`Invalid stash reference: "${stashRef}"`);
  }
  return stashRef;
}

/**
 * Snapshot types
 */
export const SnapshotType = {
  BASELINE: 'baseline',        // Initial state when session starts
  CHECKPOINT: 'checkpoint',    // Manual checkpoint
  PRE_MERGE: 'pre-merge',     // Before merging from another branch
  PRE_COMMIT: 'pre-commit',   // Before committing
  AUTO: 'auto',               // Automatic periodic snapshot
  PRE_DESTROY: 'pre-destroy'  // Before destroying worktree
};

/**
 * Create a snapshot of the current working directory state
 * @param {string} sessionId - Session identifier
 * @param {string} type - Snapshot type
 * @param {string} message - Optional message describing the snapshot
 * @returns {Promise<{id: string, type: string, timestamp: number, message: string, stashRef: string}>}
 */
export async function createSnapshot(sessionId, type = SnapshotType.AUTO, message = '') {
  // Validate session ID to prevent command injection
  const validSessionId = validateSessionId(sessionId);

  // Validate snapshot type
  const validTypes = Object.values(SnapshotType);
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid snapshot type: "${type}". Valid types: ${validTypes.join(', ')}`);
  }

  const repoRoot = getRepoRoot();
  const timestamp = Date.now();
  const snapshotId = `${validSessionId}-${type}-${timestamp}`;

  // Create snapshot metadata
  const metadata = {
    id: snapshotId,
    sessionId,
    type,
    timestamp,
    message,
    branch: getCurrentBranch(),
    commitHash: getCurrentCommitHash(),
    hasUncommittedChanges: hasUncommittedChanges(),
    hasUntrackedFiles: hasUntrackedFiles()
  };

  // Ensure snapshot directory exists
  const snapshotDir = join(repoRoot, SNAPSHOT_BASE, sessionId);
  await mkdir(snapshotDir, { recursive: true });

  // If there are uncommitted changes, create a git stash
  let stashRef = null;
  if (metadata.hasUncommittedChanges || metadata.hasUntrackedFiles) {
    stashRef = createStash(snapshotId);
    metadata.stashRef = stashRef;
  }

  // Save metadata
  const metadataPath = join(snapshotDir, `${snapshotId}.json`);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  return metadata;
}

/**
 * Restore a snapshot
 * @param {string} snapshotId - Snapshot ID to restore
 * @param {boolean} force - Force restore even with uncommitted changes
 * @returns {Promise<void>}
 */
export async function restoreSnapshot(snapshotId, force = false) {
  const repoRoot = getRepoRoot();

  // Find snapshot metadata
  const metadata = await getSnapshotMetadata(snapshotId);
  if (!metadata) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  // Validate commit hash before using in command
  const validCommitHash = validateCommitHash(metadata.commitHash);

  // Check for uncommitted changes
  if (!force && (hasUncommittedChanges() || hasUntrackedFiles())) {
    throw new Error(
      'Cannot restore snapshot: uncommitted changes present. Use --force to override.'
    );
  }

  // Restore commit state
  try {
    execSync(`git checkout "${validCommitHash}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (error) {
    throw new Error(`Failed to checkout commit ${validCommitHash}: ${error.message}`);
  }

  // Restore stash if exists - use apply to allow multiple restores
  if (metadata.stashRef) {
    const validStashRef = validateStashRef(metadata.stashRef);
    try {
      // Use 'apply' instead of 'pop' to keep stash for multiple restores
      // The stash is only dropped when the snapshot is deleted
      execSync(`git stash apply "${validStashRef}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      // Track restoration in metadata (but keep stashRef for future restores)
      const metadataPath = join(
        repoRoot,
        SNAPSHOT_BASE,
        metadata.sessionId,
        `${snapshotId}.json`
      );
      metadata.lastRestoredAt = Date.now();
      metadata.restoreCount = (metadata.restoreCount || 0) + 1;
      await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      throw new Error(`Failed to apply stash ${validStashRef}: ${error.message}`);
    }
  }
}

/**
 * List all snapshots for a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Array<Object>>}
 */
export async function listSnapshots(sessionId) {
  const repoRoot = getRepoRoot();
  const snapshotDir = join(repoRoot, SNAPSHOT_BASE, sessionId);

  if (!existsSync(snapshotDir)) {
    return [];
  }

  const files = await readdir(snapshotDir);
  const snapshots = [];

  for (const file of files) {
    if (file.endsWith('.json')) {
      const metadataPath = join(snapshotDir, file);
      const content = await readFile(metadataPath, 'utf8');
      snapshots.push(JSON.parse(content));
    }
  }

  // Sort by timestamp (newest first)
  snapshots.sort((a, b) => b.timestamp - a.timestamp);

  return snapshots;
}

/**
 * Delete a snapshot
 * @param {string} snapshotId - Snapshot ID to delete
 * @returns {Promise<void>}
 */
export async function deleteSnapshot(snapshotId) {
  const metadata = await getSnapshotMetadata(snapshotId);
  if (!metadata) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  const repoRoot = getRepoRoot();
  const metadataPath = join(
    repoRoot,
    SNAPSHOT_BASE,
    metadata.sessionId,
    `${snapshotId}.json`
  );

  // Delete stash if it exists
  if (metadata.stashRef) {
    const validStashRef = validateStashRef(metadata.stashRef);
    try {
      execSync(`git stash drop "${validStashRef}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (error) {
      // Check if stash still exists - if yes, it's a real error
      const stashList = execSync('git stash list', { encoding: 'utf8' });
      if (stashList.includes(validStashRef)) {
        throw new Error(`Failed to drop stash ${validStashRef}: stash still exists`);
      }
      // Stash already gone (possibly from earlier operation), safe to continue
    }
  }

  // Now safe to delete metadata file
  await rm(metadataPath, { force: true });
}

/**
 * Delete all snapshots for a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise<number>} Number of snapshots deleted
 */
export async function deleteAllSnapshots(sessionId) {
  const snapshots = await listSnapshots(sessionId);

  for (const snapshot of snapshots) {
    await deleteSnapshot(snapshot.id);
  }

  // Remove session directory if empty
  const repoRoot = getRepoRoot();
  const snapshotDir = join(repoRoot, SNAPSHOT_BASE, sessionId);

  try {
    await rm(snapshotDir, { recursive: true, force: true });
  } catch {
    // Directory might not be empty or might not exist, that's ok
  }

  return snapshots.length;
}

/**
 * Get diff between current state and a snapshot
 * @param {string} snapshotId - Snapshot ID
 * @returns {Promise<string>}
 */
export async function getSnapshotDiff(snapshotId) {
  const metadata = await getSnapshotMetadata(snapshotId);
  if (!metadata) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  // Validate commit hash before using in command
  const validCommitHash = validateCommitHash(metadata.commitHash);

  try {
    const diff = execSync(`git diff "${validCommitHash}"`, {
      encoding: 'utf8'
    });
    return diff;
  } catch (error) {
    throw new Error(`Failed to get diff: ${error.message}`);
  }
}

// Helper functions

function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function getCurrentCommitHash() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function hasUncommittedChanges() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    // Check for modified or staged files (lines starting with M, A, D, etc.)
    return status.split('\n').some(line => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('??');
    });
  } catch {
    return false;
  }
}

function hasUntrackedFiles() {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    // Check for untracked files (lines starting with ??)
    return status.includes('??');
  } catch {
    return false;
  }
}

function createStash(snapshotId) {
  // snapshotId is already validated in createSnapshot, but double-check format
  // to ensure no shell metacharacters in stash message
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*-[a-z-]+-\d+$/.test(snapshotId)) {
    throw new Error(`Invalid snapshot ID for stash: ${snapshotId}`);
  }

  try {
    execSync(`git stash push -u -m "snapshot:${snapshotId}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });

    // Get the stash reference
    const stashList = execSync('git stash list', { encoding: 'utf8' });
    const match = stashList.match(/stash@\{0\}/);
    return match ? match[0] : null;
  } catch (error) {
    throw new Error(`Failed to create stash: ${error.message}`);
  }
}

async function getSnapshotMetadata(snapshotId) {
  const repoRoot = getRepoRoot();
  const sessionId = snapshotId.split('-')[0];
  const metadataPath = join(repoRoot, SNAPSHOT_BASE, sessionId, `${snapshotId}.json`);

  if (!existsSync(metadataPath)) {
    return null;
  }

  const content = await readFile(metadataPath, 'utf8');
  return JSON.parse(content);
}
