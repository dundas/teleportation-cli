/**
 * Tests for Session Registry Manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

// Mock worktree manager
vi.mock('../worktree/manager.js', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/test/repo')
}));

// Import after mocking
import {
  registerSession,
  getSession,
  listSessions,
  completeSession,
  pauseSession,
  resumeSession,
  unregisterSession,
  detectConflicts,
  cleanupStaleSessions,
  getSessionStats
} from './manager.js';

describe('Session Registry Manager', () => {
  const mockSessions = [
    {
      id: 'session-1',
      agent: 'claude-code',
      worktreePath: '/test/repo/.teleportation/sessions/session-1',
      branch: 'feature/test-1',
      repoRoot: '/test/repo',
      startedAt: Date.now() - 3600000, // 1 hour ago
      lastActiveAt: Date.now() - 1800000, // 30 mins ago
      status: 'active',
      modifiedFiles: ['src/file1.js', 'src/file2.js']
    },
    {
      id: 'session-2',
      agent: 'windsurf',
      worktreePath: '/test/repo/.teleportation/sessions/session-2',
      branch: 'feature/test-2',
      repoRoot: '/test/repo',
      startedAt: Date.now() - 7200000, // 2 hours ago
      lastActiveAt: Date.now() - 600000, // 10 mins ago
      status: 'active',
      modifiedFiles: ['src/file2.js', 'src/file3.js']
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(true);
    fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));
    fs.writeFile.mockResolvedValue();
    fs.mkdir.mockResolvedValue();
  });

  describe('listSessions', () => {
    it('should return all sessions', async () => {
      const sessions = await listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('session-1');
      expect(sessions[1].id).toBe('session-2');
    });

    it('should filter by status', async () => {
      const updatedSessions = [...mockSessions];
      updatedSessions[1].status = 'completed';
      fs.readFile.mockResolvedValue(JSON.stringify(updatedSessions));

      const activeSessions = await listSessions('active');

      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].id).toBe('session-1');
    });

    it('should return empty array when registry file does not exist', async () => {
      existsSync.mockReturnValue(false);

      const sessions = await listSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('getSession', () => {
    it('should return session by ID', async () => {
      const session = await getSession('session-1');

      expect(session).not.toBeNull();
      expect(session.id).toBe('session-1');
      expect(session.agent).toBe('claude-code');
    });

    it('should return null for non-existent session', async () => {
      const session = await getSession('non-existent');

      expect(session).toBeNull();
    });
  });

  describe('registerSession', () => {
    it('should add new session to registry', async () => {
      const newSession = await registerSession(
        'session-3',
        'cursor',
        '/test/repo/.teleportation/sessions/session-3',
        'feature/test-3'
      );

      expect(newSession.id).toBe('session-3');
      expect(newSession.agent).toBe('cursor');
      expect(newSession.status).toBe('active');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should throw error if session already exists', async () => {
      await expect(
        registerSession(
          'session-1',
          'claude-code',
          '/path',
          'branch'
        )
      ).rejects.toThrow('Session session-1 is already registered');
    });
  });

  describe('completeSession', () => {
    it('should mark session as completed', async () => {
      await completeSession('session-1');

      expect(fs.writeFile).toHaveBeenCalled();
      const writtenData = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const session = writtenData.find(s => s.id === 'session-1');
      expect(session.status).toBe('completed');
    });

    it('should throw error for non-existent session', async () => {
      await expect(completeSession('non-existent')).rejects.toThrow(
        'Session non-existent not found'
      );
    });
  });

  describe('pauseSession', () => {
    it('should mark session as paused', async () => {
      await pauseSession('session-1');

      expect(fs.writeFile).toHaveBeenCalled();
      const writtenData = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const session = writtenData.find(s => s.id === 'session-1');
      expect(session.status).toBe('paused');
    });
  });

  describe('resumeSession', () => {
    it('should mark session as active', async () => {
      const pausedSessions = [...mockSessions];
      pausedSessions[0].status = 'paused';
      fs.readFile.mockResolvedValue(JSON.stringify(pausedSessions));

      await resumeSession('session-1');

      expect(fs.writeFile).toHaveBeenCalled();
      const writtenData = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const session = writtenData.find(s => s.id === 'session-1');
      expect(session.status).toBe('active');
    });
  });

  describe('unregisterSession', () => {
    it('should remove session from registry', async () => {
      await unregisterSession('session-1');

      expect(fs.writeFile).toHaveBeenCalled();
      const writtenData = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].id).toBe('session-2');
    });

    it('should throw error for non-existent session', async () => {
      await expect(unregisterSession('non-existent')).rejects.toThrow(
        'Session non-existent not found'
      );
    });
  });

  describe('detectConflicts', () => {
    it('should detect conflicting files between sessions', async () => {
      // Reset mock with fresh data for this test
      fs.readFile.mockResolvedValue(JSON.stringify([
        {
          id: 'session-1',
          agent: 'claude-code',
          worktreePath: '/test/repo/.teleportation/sessions/session-1',
          branch: 'feature/test-1',
          repoRoot: '/test/repo',
          startedAt: Date.now() - 3600000,
          lastActiveAt: Date.now() - 1800000,
          status: 'active',
          modifiedFiles: ['src/file1.js', 'src/file2.js']
        },
        {
          id: 'session-2',
          agent: 'windsurf',
          worktreePath: '/test/repo/.teleportation/sessions/session-2',
          branch: 'feature/test-2',
          repoRoot: '/test/repo',
          startedAt: Date.now() - 7200000,
          lastActiveAt: Date.now() - 600000,
          status: 'active',
          modifiedFiles: ['src/file2.js', 'src/file3.js']
        }
      ]));

      const conflicts = await detectConflicts('session-1');

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].sessionId).toBe('session-2');
      expect(conflicts[0].conflictingFiles).toContain('src/file2.js');
    });

    it('should return empty array when no conflicts', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify([
        {
          id: 'session-1',
          agent: 'claude-code',
          worktreePath: '/test/repo/.teleportation/sessions/session-1',
          branch: 'feature/test-1',
          repoRoot: '/test/repo',
          startedAt: Date.now(),
          lastActiveAt: Date.now(),
          status: 'active',
          modifiedFiles: ['src/file1.js', 'src/file2.js']
        },
        {
          id: 'session-2',
          agent: 'windsurf',
          worktreePath: '/test/repo/.teleportation/sessions/session-2',
          branch: 'feature/test-2',
          repoRoot: '/test/repo',
          startedAt: Date.now(),
          lastActiveAt: Date.now(),
          status: 'active',
          modifiedFiles: ['src/other.js']  // No overlap
        }
      ]));

      const conflicts = await detectConflicts('session-1');

      expect(conflicts).toEqual([]);
    });

    it('should throw error for non-existent session', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify(mockSessions));
      await expect(detectConflicts('non-existent')).rejects.toThrow(
        'Session non-existent not found'
      );
    });
  });

  describe('getSessionStats', () => {
    it('should return session statistics', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify([
        {
          id: 'session-1',
          agent: 'claude-code',
          status: 'active',
          modifiedFiles: []
        },
        {
          id: 'session-2',
          agent: 'windsurf',
          status: 'completed',
          modifiedFiles: []
        }
      ]));

      const stats = await getSessionStats();

      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.paused).toBe(0);
    });
  });

  describe('cleanupStaleSessions', () => {
    it('should remove sessions inactive for more than 24 hours', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify([
        {
          id: 'session-1',
          status: 'active',
          lastActiveAt: Date.now() - 1000 // recent
        },
        {
          id: 'session-2',
          status: 'active',
          lastActiveAt: Date.now() - (25 * 60 * 60 * 1000) // 25 hours ago - stale
        }
      ]));

      const removed = await cleanupStaleSessions();

      expect(removed).toBe(1);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should return 0 when no stale sessions', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify([
        {
          id: 'session-1',
          status: 'active',
          lastActiveAt: Date.now() - 1000 // recent
        },
        {
          id: 'session-2',
          status: 'active',
          lastActiveAt: Date.now() - 1000 // recent
        }
      ]));

      const removed = await cleanupStaleSessions();

      expect(removed).toBe(0);
    });
  });
});
