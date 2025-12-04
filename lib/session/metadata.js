#!/usr/bin/env node
/**
 * Session metadata extraction module
 * Extracts project information, git status, and other context
 */

import { execSync } from 'child_process';
import { basename, dirname, join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { stat, readFile } from 'fs/promises';

/**
 * Extract project name from git repository or fall back to directory name
 */
export async function getProjectName(cwd) {
  try {
    // Try to get git remote URL
    const gitRemote = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    
    if (gitRemote) {
      // Extract repo name from URL (handles both SSH and HTTPS)
      const match = gitRemote.match(/(?:.*\/)?([^\/]+?)(?:\.git)?$/);
      if (match && match[1]) {
        return match[1];
      }
    }
  } catch (e) {
    // Not a git repo or git command failed
  }
  
  // Fall back to directory name
  return basename(cwd);
}

/**
 * Get current git branch name
 */
export function getCurrentBranch(cwd) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return branch || null;
  } catch (e) {
    return null;
  }
}

/**
 * Get current git commit hash (short)
 */
export function getCommitHash(cwd) {
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return hash || null;
  } catch (e) {
    return null;
  }
}

/**
 * Get last edited file from git status
 */
export function getLastEditedFile(cwd) {
  try {
    // Get modified files from git status
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    
    if (status) {
      // Get the first modified file
      const lines = status.split('\n').filter(line => line.trim());
      if (lines.length > 0) {
        // Format: " M file.js" or "MM file.js" etc.
        // Git status porcelain format: XY filename (X = index, Y = working tree)
        // Format is exactly: "XY filename" where XY is 2 chars, then space, then filename
        // Note: line may have leading space, so we need to handle both cases
        const line = lines[0];
        // Find the space after XY and take everything after it
        // Match: optional leading space, then 2 chars (XY), then whitespace, then filename
        const match = line.match(/^\s*.{2}\s+(.+)$/);
        if (match && match[1]) {
          return match[1].trim();
        }
        // Fallback: find first space after position 2 and take everything after it
        const trimmed = line.trim();
        if (trimmed.length > 2) {
          const spaceIndex = trimmed.indexOf(' ', 2);
          if (spaceIndex > 0 && spaceIndex < trimmed.length - 1) {
            return trimmed.substring(spaceIndex + 1).trim();
          }
        }
      }
    }
    
    // Try to get the most recently modified file from git log
    const lastFile = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files -m | head -1', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true
    }).trim();
    
    return lastFile || null;
  } catch (e) {
    return null;
  }
}

/**
 * Get recent commit messages (last N commits)
 */
export function getRecentCommits(cwd, count = 3) {
  try {
    const log = execSync(`git log -${count} --pretty=format:"%h|%s"`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    
    if (!log) return [];
    
    return log.split('\n').map(line => {
      const [hash, ...messageParts] = line.split('|');
      return {
        hash: hash || '',
        message: messageParts.join('|') || ''
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Extract current task from recent commit messages
 * Looks for patterns like "feat:", "fix:", "task:", etc.
 */
export function getCurrentTask(cwd) {
  try {
    const commits = getRecentCommits(cwd, 1);
    if (commits.length > 0 && commits[0].message) {
      const message = commits[0].message;
      
      // Try to extract task from commit message
      // Patterns: "feat: description", "fix: description", "task: description"
      const match = message.match(/^(feat|fix|task|chore|docs|refactor|test|perf|style):\s*(.+)/i);
      if (match && match[2]) {
        return match[2].trim();
      }
      
      // Return first line of commit message
      return message.split('\n')[0].trim();
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Check if directory is a git repository
 */
export function isGitRepo(cwd) {
  try {
    execSync('git rev-parse --git-dir', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Get system information
 */
export function getSystemInfo() {
  return {
    hostname: hostname(),
    username: userInfo().username,
    platform: process.platform,
    nodeVersion: process.version
  };
}

/**
 * Get current Claude model being used
 * Checks in order: ANTHROPIC_MODEL env var > CLAUDE_MODEL env var > settings.json
 */
export async function getCurrentModel() {
  // Priority 1: Environment variables
  const envModel = process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL;
  if (envModel) {
    return envModel;
  }

  // Priority 2: Read from ~/.claude/settings.json
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const settingsContent = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(settingsContent);
    if (settings.model) {
      return settings.model;
    }
  } catch (e) {
    // Settings file doesn't exist or doesn't have model - that's ok
  }

  // No explicit model configured - return null (will use session default)
  return null;
}

/**
 * Extract all session metadata for a given working directory
 */
export async function extractSessionMetadata(cwd) {
  const systemInfo = getSystemInfo();
  const isGit = isGitRepo(cwd);
  const currentModel = await getCurrentModel();

  const metadata = {
    session_id: null, // Will be set by caller
    project_name: await getProjectName(cwd),
    working_directory: cwd,
    last_file_edited: isGit ? getLastEditedFile(cwd) : null,
    current_branch: isGit ? getCurrentBranch(cwd) : null,
    commit_hash: isGit ? getCommitHash(cwd) : null,
    recent_commits: isGit ? getRecentCommits(cwd, 3) : [],
    current_task: isGit ? getCurrentTask(cwd) : null,
    current_model: currentModel, // Claude model being used in this session
    hostname: systemInfo.hostname,
    username: systemInfo.username,
    platform: systemInfo.platform,
    node_version: systemInfo.nodeVersion,
    is_git_repo: isGit
    // Note: started_at is intentionally NOT set here - it should only be set once
    // when the session is first created in the relay server, not on re-registration
  };

  return metadata;
}

