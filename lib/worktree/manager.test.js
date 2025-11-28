/**
 * Tests for Worktree Manager
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
  rm: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

// Import after mocking
import {
  listWorktrees,
  getRepoRoot,
  isInWorktree,
  getCurrentSessionId,
  validateSessionId,
  validateBranchName,
  createWorktree
} from './manager.js';

describe('Worktree Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getRepoRoot', () => {
    it('should return the repository root path', () => {
      child_process.execSync.mockReturnValue('/path/to/repo\n');

      const result = getRepoRoot();

      expect(result).toBe('/path/to/repo');
      expect(child_process.execSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        { encoding: 'utf8' }
      );
    });

    it('should throw error when not in git repository', () => {
      child_process.execSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      expect(() => getRepoRoot()).toThrow('Not in a git repository');
    });
  });

  describe('listWorktrees', () => {
    it('should parse git worktree list output', () => {
      const porcelainOutput = `worktree /path/to/main
HEAD abc123def456
branch refs/heads/main

worktree /path/to/feature
HEAD def456abc789
branch refs/heads/feature/test

`;
      child_process.execSync.mockReturnValue(porcelainOutput);

      const result = listWorktrees();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/path/to/main',
        branch: 'main',
        commitHash: 'abc123def456'
      });
      expect(result[1]).toEqual({
        path: '/path/to/feature',
        branch: 'feature/test',
        commitHash: 'def456abc789'
      });
    });

    it('should return empty array when no worktrees', () => {
      child_process.execSync.mockReturnValue('');

      const result = listWorktrees();

      expect(result).toEqual([]);
    });

    it('should throw error on git failure', () => {
      child_process.execSync.mockImplementation(() => {
        throw new Error('git error');
      });

      expect(() => listWorktrees()).toThrow('Failed to list worktrees');
    });
  });

  describe('isInWorktree', () => {
    it('should return true when in a session worktree', () => {
      const originalCwd = process.cwd;
      process.cwd = vi.fn().mockReturnValue('/repo/.teleportation/sessions/my-session');
      child_process.execSync.mockReturnValue('/repo\n');

      const result = isInWorktree();

      expect(result).toBe(true);
      process.cwd = originalCwd;
    });

    it('should return false when in main repo', () => {
      const originalCwd = process.cwd;
      process.cwd = vi.fn().mockReturnValue('/repo');
      child_process.execSync.mockReturnValue('/repo\n');

      const result = isInWorktree();

      expect(result).toBe(false);
      process.cwd = originalCwd;
    });

    it('should return false when not in git repo', () => {
      child_process.execSync.mockImplementation(() => {
        throw new Error('not a git repo');
      });

      const result = isInWorktree();

      expect(result).toBe(false);
    });
  });

  describe('getCurrentSessionId', () => {
    it('should extract session ID from worktree path', () => {
      const originalCwd = process.cwd;
      process.cwd = vi.fn().mockReturnValue('/repo/.teleportation/sessions/test-session/subdir');
      child_process.execSync.mockReturnValue('/repo\n');

      const result = getCurrentSessionId();

      expect(result).toBe('test-session');
      process.cwd = originalCwd;
    });

    it('should return null when not in worktree', () => {
      const originalCwd = process.cwd;
      process.cwd = vi.fn().mockReturnValue('/repo');
      child_process.execSync.mockReturnValue('/repo\n');

      const result = getCurrentSessionId();

      expect(result).toBe(null);
      process.cwd = originalCwd;
    });
  });

  describe('Input Validation - Security', () => {
    describe('validateSessionId', () => {
      it('should accept valid session IDs', () => {
        expect(validateSessionId('my-session')).toBe('my-session');
        expect(validateSessionId('session123')).toBe('session123');
        expect(validateSessionId('test_session')).toBe('test_session');
        expect(validateSessionId('a')).toBe('a');
      });

      it('should reject session ID with shell metacharacters', () => {
        expect(() => validateSessionId('test; rm -rf /')).toThrow('Invalid session ID');
        expect(() => validateSessionId('$(whoami)')).toThrow('Invalid session ID');
        expect(() => validateSessionId('test`id`')).toThrow('Invalid session ID');
        expect(() => validateSessionId('test|cat /etc/passwd')).toThrow('Invalid session ID');
        expect(() => validateSessionId('test && echo hacked')).toThrow('Invalid session ID');
      });

      it('should reject empty or null session ID', () => {
        expect(() => validateSessionId('')).toThrow('Session ID is required');
        expect(() => validateSessionId(null)).toThrow('Session ID is required');
        expect(() => validateSessionId(undefined)).toThrow('Session ID is required');
      });

      it('should reject session ID starting with non-alphanumeric', () => {
        expect(() => validateSessionId('-invalid')).toThrow('Invalid session ID');
        expect(() => validateSessionId('_invalid')).toThrow('Invalid session ID');
        expect(() => validateSessionId('.invalid')).toThrow('Invalid session ID');
      });

      it('should reject session ID that is too long', () => {
        const longId = 'a'.repeat(65);
        expect(() => validateSessionId(longId)).toThrow('Invalid session ID');
      });
    });

    describe('validateBranchName', () => {
      it('should accept valid branch names', () => {
        expect(validateBranchName('main')).toBe('main');
        expect(validateBranchName('feature/test')).toBe('feature/test');
        expect(validateBranchName('fix-bug-123')).toBe('fix-bug-123');
        expect(validateBranchName('release/v1.0.0')).toBe('release/v1.0.0');
      });

      it('should reject branch name with shell metacharacters', () => {
        expect(() => validateBranchName('$(whoami)')).toThrow('Invalid branch name');
        expect(() => validateBranchName('test`id`')).toThrow('Invalid branch name');
        expect(() => validateBranchName('test;echo hacked')).toThrow('Invalid branch name');
      });

      it('should reject invalid git branch patterns', () => {
        expect(() => validateBranchName('branch..name')).toThrow('invalid git reference');
        expect(() => validateBranchName('branch.lock')).toThrow('invalid git reference');
        expect(() => validateBranchName('branch/')).toThrow('invalid git reference');
      });

      it('should reject empty or null branch name', () => {
        expect(() => validateBranchName('')).toThrow('Branch name is required');
        expect(() => validateBranchName(null)).toThrow('Branch name is required');
      });
    });

    describe('createWorktree input validation', () => {
      it('should reject malicious session ID', async () => {
        await expect(
          createWorktree('test; rm -rf /', 'feature/branch', 'main')
        ).rejects.toThrow('Invalid session ID');
      });

      it('should reject malicious branch name', async () => {
        child_process.execSync.mockReturnValue('/repo\n');
        existsSync.mockReturnValue(false);
        fs.mkdir.mockResolvedValue();

        await expect(
          createWorktree('valid-session', '$(whoami)', 'main')
        ).rejects.toThrow('Invalid branch name');
      });

      it('should reject malicious base branch', async () => {
        child_process.execSync.mockReturnValue('/repo\n');
        existsSync.mockReturnValue(false);
        fs.mkdir.mockResolvedValue();

        await expect(
          createWorktree('valid-session', 'feature/test', '`id`')
        ).rejects.toThrow('Invalid branch name');
      });
    });
  });
});
