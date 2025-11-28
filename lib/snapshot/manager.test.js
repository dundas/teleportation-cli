/**
 * Tests for Snapshot Manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

// Mock child_process and fs
vi.mock('child_process', () => ({
  execSync: vi.fn()
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

// Mock worktree manager - include validateSessionId
vi.mock('../worktree/manager.js', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/test/repo'),
  validateSessionId: vi.fn((id) => {
    if (!id || typeof id !== 'string') {
      throw new Error('Session ID is required');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`Invalid session ID: "${id}"`);
    }
    return id;
  })
}));

// Import after mocking
import {
  createSnapshot,
  listSnapshots,
  deleteSnapshot,
  getSnapshotDiff,
  SnapshotType
} from './manager.js';

describe('Snapshot Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue();
    fs.writeFile.mockResolvedValue();
    existsSync.mockReturnValue(true);
  });

  describe('SnapshotType', () => {
    it('should define all snapshot types', () => {
      expect(SnapshotType.BASELINE).toBe('baseline');
      expect(SnapshotType.CHECKPOINT).toBe('checkpoint');
      expect(SnapshotType.PRE_MERGE).toBe('pre-merge');
      expect(SnapshotType.PRE_COMMIT).toBe('pre-commit');
      expect(SnapshotType.AUTO).toBe('auto');
      expect(SnapshotType.PRE_DESTROY).toBe('pre-destroy');
    });
  });

  describe('createSnapshot', () => {
    it('should create a snapshot with metadata', async () => {
      child_process.execSync
        .mockReturnValueOnce('feature/test\n') // getCurrentBranch
        .mockReturnValueOnce('abc123\n') // getCurrentCommitHash
        .mockReturnValueOnce('') // git status (no changes)
        .mockReturnValueOnce(''); // git status (no untracked)

      const snapshot = await createSnapshot(
        'test-session',
        SnapshotType.CHECKPOINT,
        'Test checkpoint'
      );

      expect(snapshot).toMatchObject({
        sessionId: 'test-session',
        type: 'checkpoint',
        message: 'Test checkpoint',
        branch: 'feature/test',
        commitHash: 'abc123',
        hasUncommittedChanges: false,
        hasUntrackedFiles: false
      });
      expect(snapshot.id).toMatch(/^test-session-checkpoint-\d+$/);
      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should create stash when there are uncommitted changes', async () => {
      child_process.execSync
        .mockReturnValueOnce('main\n') // getCurrentBranch
        .mockReturnValueOnce('def456\n') // getCurrentCommitHash
        .mockReturnValueOnce(' M src/file.js\n') // git status (modified)
        .mockReturnValueOnce('?? new.js\n') // git status (untracked)
        .mockReturnValueOnce('') // git stash push
        .mockReturnValueOnce('stash@{0}: On main: snapshot:test-session-checkpoint-123\n'); // git stash list

      const snapshot = await createSnapshot(
        'test-session',
        SnapshotType.CHECKPOINT
      );

      expect(snapshot.hasUncommittedChanges).toBe(true);
      expect(snapshot.hasUntrackedFiles).toBe(true);
      expect(snapshot.stashRef).toBe('stash@{0}');
    });
  });

  describe('listSnapshots', () => {
    it('should return all snapshots for a session', async () => {
      existsSync.mockReturnValue(true);
      fs.readdir.mockResolvedValue([
        'test-session-baseline-100.json',
        'test-session-checkpoint-200.json'
      ]);
      fs.readFile.mockImplementation((path) => {
        if (path.includes('baseline-100')) {
          return Promise.resolve(JSON.stringify({
            id: 'test-session-baseline-100',
            type: 'baseline',
            timestamp: 100
          }));
        }
        return Promise.resolve(JSON.stringify({
          id: 'test-session-checkpoint-200',
          type: 'checkpoint',
          timestamp: 200
        }));
      });

      const snapshots = await listSnapshots('test-session');

      expect(snapshots).toHaveLength(2);
      // Should be sorted by timestamp (newest first)
      expect(snapshots[0].id).toBe('test-session-checkpoint-200');
      expect(snapshots[1].id).toBe('test-session-baseline-100');
    });

    it('should return empty array when no snapshots exist', async () => {
      existsSync.mockReturnValue(false);

      const snapshots = await listSnapshots('test-session');

      expect(snapshots).toEqual([]);
    });
  });

  describe('deleteSnapshot', () => {
    it('should delete snapshot and stash', async () => {
      const snapshotMetadata = {
        id: 'test-session-checkpoint-100',
        sessionId: 'test-session',
        stashRef: 'stash@{0}'
      };
      existsSync.mockReturnValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(snapshotMetadata));
      fs.rm.mockResolvedValue();
      child_process.execSync.mockReturnValue('');

      await deleteSnapshot('test-session-checkpoint-100');

      expect(child_process.execSync).toHaveBeenCalledWith(
        expect.stringContaining('git stash drop'),
        expect.any(Object)
      );
      expect(fs.rm).toHaveBeenCalled();
    });

    it('should throw error for non-existent snapshot', async () => {
      existsSync.mockReturnValue(false);

      await expect(deleteSnapshot('non-existent')).rejects.toThrow(
        'Snapshot not found'
      );
    });
  });

  describe('getSnapshotDiff', () => {
    it('should return diff between current state and snapshot', async () => {
      const snapshotMetadata = {
        id: 'test-session-checkpoint-100',
        sessionId: 'test-session',
        commitHash: 'abc123def' // Must be 7+ hex chars for validation
      };
      existsSync.mockReturnValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(snapshotMetadata));
      child_process.execSync.mockReturnValue(
        'diff --git a/file.js b/file.js\n+new line\n'
      );

      const diff = await getSnapshotDiff('test-session-checkpoint-100');

      expect(diff).toContain('+new line');
      expect(child_process.execSync).toHaveBeenCalledWith(
        'git diff "abc123def"',
        expect.any(Object)
      );
    });

    it('should throw error for non-existent snapshot', async () => {
      existsSync.mockReturnValue(false);

      await expect(getSnapshotDiff('non-existent')).rejects.toThrow(
        'Snapshot not found'
      );
    });
  });
});
