#!/usr/bin/env node
/**
 * Installation module for Teleportation
 * Handles setting up hooks and settings at the PROJECT level (not global)
 * 
 * Project-level installation:
 * - Hooks live in PROJECT/.claude/hooks/ (source files, not copied)
 * - Settings live in PROJECT/.claude/settings.json (with absolute paths)
 * - Daemon lives in ~/.teleportation/daemon/ (shared across projects)
 */

import { copyFile, mkdir, chmod, readFile, writeFile, stat, readdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME_DIR = homedir();

// Protocol/config version - increment when hooks behavior changes significantly
// This helps identify outdated installations that may not send all required metadata
export const TELEPORTATION_VERSION = '1.1.0';
export const TELEPORTATION_PROTOCOL_VERSION = 2;

// Runtime getters to respect environment variables set after module load
function getTeleportationDir() {
  return process.env.TELEPORTATION_DIR || join(__dirname, '..', '..');
}

function getProjectHooksDir() {
  return process.env.TEST_HOOKS_DIR || join(getTeleportationDir(), '.claude', 'hooks');
}

function getProjectSettings() {
  return process.env.TEST_SETTINGS || join(getTeleportationDir(), '.claude', 'settings.json');
}

/**
 * Check if Node.js is installed and meets version requirements
 */
export function checkNodeVersion() {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  
  if (major < 20) {
    return {
      valid: false,
      error: `Node.js 20+ required. Found: ${nodeVersion}`
    };
  }
  
  return { valid: true, version: nodeVersion };
}

/**
 * Check if Claude Code is installed
 */
export function checkClaudeCode() {
  try {
    const claudePath = execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (claudePath) {
      return { valid: true, path: claudePath };
    }
  } catch (e) {
    // Claude not found
  }
  
  return {
    valid: false,
    error: 'Claude Code not found in PATH. Please install Claude Code first.'
  };
}

/**
 * Ensure required directories exist
 */
export async function ensureDirectories() {
  const projectDir = getTeleportationDir();
  const hooksDir = getProjectHooksDir();
  const settingsDir = dirname(getProjectSettings());

  const dirs = [
    settingsDir,
    hooksDir,
    join(HOME_DIR, '.teleportation'),
    join(HOME_DIR, '.teleportation', 'daemon')
  ];

  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw new Error(`Failed to create directory ${dir}: ${e.message}`);
      }
    }
  }

  return dirs;
}

/**
 * Verify hooks exist in project directory (no copying - they're source files)
 */
export async function verifyHooks(sourceHooksDir) {
  const hooks = [
    'pre_tool_use.mjs',
    'permission_request.mjs',  // Handles remote approvals when user is away
    'post_tool_use.mjs',       // Records tool executions to timeline
    'session_start.mjs',
    'session_end.mjs',
    'stop.mjs',
    'notification.mjs',
    'config-loader.mjs',
    'session-register.mjs'
  ];

  const found = [];
  const missing = [];

  for (const hook of hooks) {
    const hookPath = join(sourceHooksDir, hook);
    try {
      await stat(hookPath);
      // Set executable permissions (755)
      await chmod(hookPath, 0o755);
      found.push(hook);
    } catch (e) {
      if (e.code === 'ENOENT') {
        missing.push(hook);
      }
    }
  }

  return { found, missing };
}

/**
 * Install hooks (verify they exist and set permissions)
 * Returns structure compatible with test expectations
 */
export async function installHooks(sourceHooksDir) {
  const result = await verifyHooks(sourceHooksDir);
  const destHooksDir = getProjectHooksDir();
  const copyFailed = [];

  // Copy hooks from source to destination if they're different
  if (sourceHooksDir !== destHooksDir) {
    for (const hook of result.found) {
      const sourcePath = join(sourceHooksDir, hook);
      const destPath = join(destHooksDir, hook);
      try {
        await copyFile(sourcePath, destPath);
        await chmod(destPath, 0o755);
      } catch (e) {
        copyFailed.push({ file: hook, error: e.message });
      }
    }
  }

  return {
    installed: result.found,
    failed: result.missing.map(hook => ({ file: hook, error: 'File not found' })).concat(copyFailed)
  };
}

/**
 * Copy daemon files to ~/.teleportation/daemon/
 */
export async function installDaemon() {
  const sourceDaemonDir = join(getTeleportationDir(), 'lib', 'daemon');
  const destDaemonDir = join(HOME_DIR, '.teleportation', 'daemon');

  const daemonFiles = [
    'teleportation-daemon.js',
    'pid-manager.js',
    'lifecycle.js'
  ];

  const installed = [];
  const failed = [];

  for (const file of daemonFiles) {
    const src = join(sourceDaemonDir, file);
    const dest = join(destDaemonDir, file);

    try {
      // Check if source exists
      await stat(src);

      // Copy file
      await copyFile(src, dest);

      // Set permissions (755 for daemon script, 644 for modules)
      const perms = file === 'teleportation-daemon.js' ? 0o755 : 0o644;
      await chmod(dest, perms);

      installed.push(file);
    } catch (e) {
      if (e.code === 'ENOENT' && e.path === src) {
        // Source file doesn't exist, skip
        continue;
      }
      failed.push({ file, error: e.message });
    }
  }

  return { installed, failed };
}

/**
 * Write version file to ~/.teleportation/version.json
 * This file is read by hooks to include version in session metadata
 */
export async function writeVersionFile() {
  const versionFile = join(HOME_DIR, '.teleportation', 'version.json');
  const versionData = {
    version: TELEPORTATION_VERSION,
    protocol_version: TELEPORTATION_PROTOCOL_VERSION,
    installed_at: new Date().toISOString(),
    installed_timestamp: Date.now()
  };

  await writeFile(versionFile, JSON.stringify(versionData, null, 2));
  return versionFile;
}

/**
 * Create Claude Code settings.json at project level with absolute paths
 */
export async function createSettings() {
  const projectHooksDir = resolve(getProjectHooksDir());
  const projectSettings = getProjectSettings();

  // Ensure parent directory exists
  await mkdir(dirname(projectSettings), { recursive: true });

  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${join(projectHooksDir, 'pre_tool_use.mjs')}`
        }]
      }],
      Stop: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${join(projectHooksDir, 'stop.mjs')}`
        }]
      }],
      SessionStart: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${join(projectHooksDir, 'session_start.mjs')}`
        }]
      }],
      SessionEnd: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${join(projectHooksDir, 'session_end.mjs')}`
        }]
      }],
      Notification: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${join(projectHooksDir, 'notification.mjs')}`
        }]
      }]
    }
  };

  await writeFile(projectSettings, JSON.stringify(settings, null, 2));
  return projectSettings;
}

/**
 * Verify installation
 */
export async function verifyInstallation() {
  const projectHooksDir = getProjectHooksDir();
  const projectSettings = getProjectSettings();

  const checks = {
    directories: false,
    hooks: false,
    settings: false
  };

  // Check directories
  try {
    await stat(projectHooksDir);
    checks.directories = true;
  } catch (e) {
    return { valid: false, checks, error: 'Directories not created' };
  }

  // Check hooks
  try {
    const hooks = await readdir(projectHooksDir);
    const requiredHooks = ['pre_tool_use.mjs', 'config-loader.mjs'];
    const foundHooks = requiredHooks.filter(h => hooks.includes(h));
    checks.hooks = foundHooks.length === requiredHooks.length;
  } catch (e) {
    return { valid: false, checks, error: 'Cannot read hooks directory' };
  }

  // Check settings
  try {
    await stat(projectSettings);
    const content = await readFile(projectSettings, 'utf8');
    const settings = JSON.parse(content);
    checks.settings = settings.hooks && Object.keys(settings.hooks).length > 0;
  } catch (e) {
    return { valid: false, checks, error: 'Settings file invalid or missing' };
  }

  const valid = Object.values(checks).every(v => v === true);
  if (!valid) {
    const failed = Object.entries(checks).filter(([_, v]) => !v).map(([k]) => k).join(', ');
    return { valid, checks, error: `Failed checks: ${failed}` };
  }
  return { valid, checks };
}

/**
 * Main installation function
 * 
 * Project-level installation:
 * - Hooks stay in PROJECT/.claude/hooks/ (source files, just verify they exist)
 * - Settings created in PROJECT/.claude/settings.json with absolute paths
 * - Daemon copied to ~/.teleportation/daemon/ (shared across projects)
 */
export async function install(sourceHooksDir) {
  // Pre-flight checks
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.valid) {
    throw new Error(nodeCheck.error);
  }

  const claudeCheck = checkClaudeCode();
  if (!claudeCheck.valid) {
    throw new Error(claudeCheck.error);
  }

  // Create directories
  await ensureDirectories();

  // Install hooks (verify and copy to destination)
  const hookResult = await installHooks(sourceHooksDir);
  if (hookResult.failed.length > 0) {
    throw new Error(`Failed to install hooks: ${hookResult.failed.map(f => f.file).join(', ')}`);
  }

  // Install daemon (still goes to ~/.teleportation/daemon/)
  const daemonResult = await installDaemon();
  if (daemonResult.failed.length > 0) {
    throw new Error(`Failed to install daemon: ${daemonResult.failed.map(f => f.file).join(', ')}`);
  }

  // Create project-level settings with absolute paths
  await createSettings();

  // Write version file
  await writeVersionFile();

  // Verify
  const verification = await verifyInstallation();
  if (!verification.valid) {
    throw new Error(`Installation verification failed: ${verification.error}`);
  }

  return {
    success: true,
    hooksInstalled: hookResult.installed.length,
    daemonInstalled: daemonResult.installed.length,
    settingsFile: getProjectSettings(),
    hooksDir: getProjectHooksDir(),
    daemonDir: join(HOME_DIR, '.teleportation', 'daemon')
  };
}

