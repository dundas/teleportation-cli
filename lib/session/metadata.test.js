/**
 * Tests for session metadata extraction module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  getProjectName,
  getCurrentBranch,
  getCommitHash,
  getLastEditedFile,
  getRecentCommits,
  getCurrentTask,
  isGitRepo,
  getSystemInfo,
  extractSessionMetadata
} from './metadata.js';

const TEST_DIR = join(tmpdir(), 'teleportation-test-metadata');

describe('session metadata', () => {
  beforeEach(async () => {
    // Clean up test directory
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
    await mkdir(TEST_DIR, { recursive: true });
  });
  
  afterEach(async () => {
    // Clean up
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });
  
  describe('getProjectName', () => {
    it('should return directory name for non-git repo', async () => {
      const name = await getProjectName(TEST_DIR);
      expect(name).toBe('teleportation-test-metadata');
    });
    
    it('should extract project name from git remote', async () => {
      // Initialize git repo
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      execSync('git remote add origin https://github.com/user/my-project.git', { cwd: TEST_DIR });
      
      const name = await getProjectName(TEST_DIR);
      expect(name).toBe('my-project');
    });
  });
  
  describe('getCurrentBranch', () => {
    it('should return null for non-git repo', () => {
      const branch = getCurrentBranch(TEST_DIR);
      expect(branch).toBeNull();
    });
    
    it('should return branch name for git repo', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      // Need at least one commit before creating a branch
      await writeFile(join(TEST_DIR, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: TEST_DIR });
      execSync('git commit -m "initial"', { cwd: TEST_DIR });
      execSync('git checkout -b feature/test', { cwd: TEST_DIR });
      
      const branch = getCurrentBranch(TEST_DIR);
      expect(branch).toBe('feature/test');
    });
  });
  
  describe('getCommitHash', () => {
    it('should return null for non-git repo', () => {
      const hash = getCommitHash(TEST_DIR);
      expect(hash).toBeNull();
    });
    
    it('should return commit hash for git repo', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      await writeFile(join(TEST_DIR, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: TEST_DIR });
      execSync('git commit -m "test commit"', { cwd: TEST_DIR });
      
      const hash = getCommitHash(TEST_DIR);
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });
  });
  
  describe('getLastEditedFile', () => {
    it('should return null for non-git repo', () => {
      const file = getLastEditedFile(TEST_DIR);
      expect(file).toBeNull();
    });
    
    it('should return modified file from git status', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      await writeFile(join(TEST_DIR, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: TEST_DIR });
      execSync('git commit -m "initial"', { cwd: TEST_DIR });
      
      // Modify file
      await writeFile(join(TEST_DIR, 'test.txt'), 'modified');
      
      const file = getLastEditedFile(TEST_DIR);
      expect(file).toBe('test.txt');
    });
  });
  
  describe('getRecentCommits', () => {
    it('should return empty array for non-git repo', () => {
      const commits = getRecentCommits(TEST_DIR);
      expect(commits).toEqual([]);
    });
    
    it('should return recent commits', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      
      await writeFile(join(TEST_DIR, 'file1.txt'), '1');
      execSync('git add file1.txt', { cwd: TEST_DIR });
      execSync('git commit -m "feat: first commit"', { cwd: TEST_DIR });
      
      await writeFile(join(TEST_DIR, 'file2.txt'), '2');
      execSync('git add file2.txt', { cwd: TEST_DIR });
      execSync('git commit -m "fix: second commit"', { cwd: TEST_DIR });
      
      const commits = getRecentCommits(TEST_DIR, 2);
      expect(commits.length).toBe(2);
      expect(commits[0].message).toContain('second commit');
      expect(commits[1].message).toContain('first commit');
    });
  });
  
  describe('getCurrentTask', () => {
    it('should return null for non-git repo', () => {
      const task = getCurrentTask(TEST_DIR);
      expect(task).toBeNull();
    });
    
    it('should extract task from commit message', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      
      await writeFile(join(TEST_DIR, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: TEST_DIR });
      execSync('git commit -m "feat: implement authentication"', { cwd: TEST_DIR });
      
      const task = getCurrentTask(TEST_DIR);
      expect(task).toBe('implement authentication');
    });
  });
  
  describe('isGitRepo', () => {
    it('should return false for non-git directory', async () => {
      // Ensure directory exists and is not a git repo
      await mkdir(TEST_DIR, { recursive: true });
      // Remove .git if it exists
      try {
        await rm(join(TEST_DIR, '.git'), { recursive: true, force: true });
      } catch (e) {
        // Ignore
      }
      const isGit = isGitRepo(TEST_DIR);
      expect(isGit).toBe(false);
    });
    
    it('should return true for git repository', () => {
      execSync('git init', { cwd: TEST_DIR });
      const isGit = isGitRepo(TEST_DIR);
      expect(isGit).toBe(true);
    });
  });
  
  describe('getSystemInfo', () => {
    it('should return system information', () => {
      const info = getSystemInfo();
      expect(info).toHaveProperty('hostname');
      expect(info).toHaveProperty('username');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('nodeVersion');
      expect(typeof info.hostname).toBe('string');
      expect(typeof info.username).toBe('string');
    });
  });
  
  describe('extractSessionMetadata', () => {
    it('should extract metadata for non-git directory', async () => {
      // Ensure directory exists and is not a git repo
      await mkdir(TEST_DIR, { recursive: true });
      // Remove .git if it exists
      try {
        await rm(join(TEST_DIR, '.git'), { recursive: true, force: true });
      } catch (e) {
        // Ignore
      }
      
      const metadata = await extractSessionMetadata(TEST_DIR);
      
      expect(metadata).toHaveProperty('project_name');
      expect(metadata).toHaveProperty('working_directory');
      expect(metadata).toHaveProperty('hostname');
      expect(metadata).toHaveProperty('username');
      expect(metadata).toHaveProperty('platform');
      expect(metadata).toHaveProperty('started_at');
      expect(metadata.is_git_repo).toBe(false);
      expect(metadata.current_branch).toBeNull();
      expect(metadata.commit_hash).toBeNull();
    });
    
    it('should extract full metadata for git repository', async () => {
      execSync('git init', { cwd: TEST_DIR });
      execSync('git config user.name "Test"', { cwd: TEST_DIR });
      execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
      execSync('git remote add origin https://github.com/user/test-repo.git', { cwd: TEST_DIR });
      
      await writeFile(join(TEST_DIR, 'test.txt'), 'test');
      execSync('git add test.txt', { cwd: TEST_DIR });
      execSync('git commit -m "feat: initial commit"', { cwd: TEST_DIR });
      execSync('git checkout -b feature/test', { cwd: TEST_DIR });
      
      const metadata = await extractSessionMetadata(TEST_DIR);
      
      expect(metadata.is_git_repo).toBe(true);
      expect(metadata.project_name).toBe('test-repo');
      expect(metadata.current_branch).toBe('feature/test');
      expect(metadata.commit_hash).toBeTruthy();
      expect(metadata.recent_commits.length).toBeGreaterThan(0);
      expect(metadata.current_task).toBeTruthy();
    });
  });
});

