#!/usr/bin/env node
/**
 * Worktree Management Module
 * Handles git worktree creation, listing, and cleanup for session isolation
 */

import { execSync } from 'child_process';
import { join, resolve, sep, relative } from 'path';
import { mkdir, rm, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';

const WORKTREE_BASE = '.teleportation/sessions';

// Input validation patterns
const VALID_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VALID_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_\-/.]{0,127}$/;

/**
 * Validate and sanitize a session ID
 * @param {string} sessionId - Session ID to validate
 * @returns {string} Validated session ID
 * @throws {Error} If session ID is invalid
 */
export function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Session ID is required');
  }
  if (!VALID_SESSION_ID.test(sessionId)) {
    throw new Error(
      `Invalid session ID: "${sessionId}". Must start with alphanumeric, contain only alphanumeric/dash/underscore, and be 1-64 characters.`
    );
  }
  return sessionId;
}

/**
 * Validate and sanitize a git branch name
 * @param {string} branchName - Branch name to validate
 * @returns {string} Validated branch name
 * @throws {Error} If branch name is invalid
 */
export function validateBranchName(branchName) {
  if (!branchName || typeof branchName !== 'string') {
    throw new Error('Branch name is required');
  }
  if (!VALID_BRANCH_NAME.test(branchName)) {
    throw new Error(
      `Invalid branch name: "${branchName}". Must start with alphanumeric and contain only alphanumeric/dash/underscore/slash/dot.`
    );
  }
  // Additional git-specific checks
  if (branchName.includes('..') || branchName.endsWith('.lock') || branchName.endsWith('/')) {
    throw new Error(`Invalid branch name: "${branchName}". Contains invalid git reference patterns.`);
  }
  return branchName;
}

/**
 * List all git worktrees
 * @returns {Array<{path: string, branch: string, commitHash: string}>}
 */
export function listWorktrees() {
  try {
    const output = execSync('git worktree list --porcelain', { encoding: 'utf8' });
    const worktrees = [];
    const lines = output.trim().split('\n');

    let current = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        current.path = line.substring(9);
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line.startsWith('HEAD ')) {
        current.commitHash = line.substring(5);
      } else if (line === '') {
        if (current.path) {
          worktrees.push(current);
          current = {};
        }
      }
    }

    // Push last one if exists
    if (current.path) {
      worktrees.push(current);
    }

    return worktrees;
  } catch (error) {
    throw new Error(`Failed to list worktrees: ${error.message}`);
  }
}

/**
 * Get the repository root directory
 * @returns {string}
 */
export function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Not in a git repository: ${error.message}`);
  }
}

/**
 * Create a new worktree for a session
 * @param {string} sessionId - Unique session identifier
 * @param {string} branchName - Name of the branch to create
 * @param {string} baseBranch - Base branch to branch from (default: 'main')
 * @returns {Promise<{path: string, branch: string}>}
 */
export async function createWorktree(sessionId, branchName, baseBranch = 'main') {
  // Validate all inputs to prevent command injection
  const validSessionId = validateSessionId(sessionId);
  const validBranchName = validateBranchName(branchName);
  const validBaseBranch = validateBranchName(baseBranch);

  const repoRoot = getRepoRoot();
  const worktreePath = resolve(repoRoot, WORKTREE_BASE, validSessionId);

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }

  // Ensure base directory exists
  await mkdir(join(repoRoot, WORKTREE_BASE), { recursive: true });

  // Check if branch already exists
  const branches = execSync('git branch --list', { encoding: 'utf8' });
  const branchExists = branches.includes(validBranchName);

  try {
    if (branchExists) {
      // Use existing branch - inputs are validated, path is quoted
      execSync(`git worktree add "${worktreePath}" "${validBranchName}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } else {
      // Create new branch from base - inputs are validated, path is quoted
      execSync(`git worktree add -b "${validBranchName}" "${worktreePath}" "${validBaseBranch}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }

    return {
      path: worktreePath,
      branch: validBranchName,
      sessionId: validSessionId
    };
  } catch (error) {
    // Clean up on failure
    if (existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true });
    }
    // Prune any stale worktree references
    try {
      execSync('git worktree prune', { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      // Prune failure is non-fatal
    }
    throw new Error(`Failed to create worktree: ${error.message}`);
  }
}

/**
 * Remove a worktree
 * @param {string} worktreePath - Path to the worktree
 * @param {boolean} force - Force removal even with uncommitted changes
 * @returns {Promise<void>}
 */
export async function removeWorktree(worktreePath, force = false) {
  const absolutePath = resolve(worktreePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Worktree not found at ${absolutePath}`);
  }

  try {
    const forceFlag = force ? '--force' : '';
    execSync(`git worktree remove ${forceFlag} "${absolutePath}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (error) {
    throw new Error(`Failed to remove worktree: ${error.message}`);
  }
}

/**
 * Prune stale worktree administrative files
 * @returns {void}
 */
export function pruneWorktrees() {
  try {
    execSync('git worktree prune', { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to prune worktrees: ${error.message}`);
  }
}

/**
 * Get worktree info by path
 * @param {string} worktreePath - Path to worktree
 * @returns {Object|null}
 */
export function getWorktreeInfo(worktreePath) {
  const worktrees = listWorktrees();
  const absolutePath = resolve(worktreePath);
  return worktrees.find(wt => wt.path === absolutePath) || null;
}

/**
 * Check if current directory is inside a worktree
 * @returns {boolean}
 */
export function isInWorktree() {
  try {
    const repoRoot = getRepoRoot();
    const currentDir = process.cwd();
    // Use path.relative for proper cross-platform comparison
    const relativePath = relative(repoRoot, currentDir);
    // Check if the relative path starts with the worktree base
    const worktreeBaseParts = WORKTREE_BASE.split('/');
    const currentParts = relativePath.split(sep);
    // Check if current path is under WORKTREE_BASE
    return worktreeBaseParts.every((part, i) => currentParts[i] === part);
  } catch {
    return false;
  }
}

/**
 * Get the session ID from current worktree path
 * @returns {string|null}
 */
export function getCurrentSessionId() {
  if (!isInWorktree()) {
    return null;
  }

  try {
    const currentDir = process.cwd();
    const repoRoot = getRepoRoot();
    // Use path.relative for cross-platform compatibility
    const relativePath = relative(repoRoot, currentDir);
    // Split using path.sep for cross-platform support (/ on Unix, \ on Windows)
    const parts = relativePath.split(sep);

    const sessionsIndex = parts.indexOf('sessions');
    if (sessionsIndex >= 0 && sessionsIndex < parts.length - 1) {
      return parts[sessionsIndex + 1];
    }
  } catch {
    // If anything fails, return null
  }

  return null;
}

/**
 * List all session worktrees
 * @returns {Promise<Array<{sessionId: string, path: string, branch: string}>>}
 */
export async function listSessionWorktrees() {
  const repoRoot = getRepoRoot();
  const sessionsDir = join(repoRoot, WORKTREE_BASE);

  if (!existsSync(sessionsDir)) {
    return [];
  }

  const allWorktrees = listWorktrees();
  const sessionWorktrees = [];

  // Get all directories in sessions folder
  const entries = await readdir(sessionsDir);

  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry);
    const entryStat = await stat(entryPath);

    if (entryStat.isDirectory()) {
      const worktreeInfo = allWorktrees.find(wt => wt.path === entryPath);
      if (worktreeInfo) {
        sessionWorktrees.push({
          sessionId: entry,
          path: entryPath,
          branch: worktreeInfo.branch,
          commitHash: worktreeInfo.commitHash
        });
      }
    }
  }

  return sessionWorktrees;
}
