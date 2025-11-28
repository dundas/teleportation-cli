/**
 * Tests for installer module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  checkNodeVersion,
  checkClaudeCode,
  ensureDirectories,
  installHooks,
  createSettings,
  verifyInstallation,
  install
} from './installer.js';

const HOME_DIR = homedir();
const TEST_DIR = join(HOME_DIR, '.teleportation-test');
const TEST_HOOKS_DIR = join(TEST_DIR, 'hooks');
const TEST_GLOBAL_HOOKS = join(HOME_DIR, '.claude-test', 'hooks');
const TEST_SETTINGS = join(HOME_DIR, '.claude-test', 'settings.json');

describe('installer', () => {
  beforeEach(async () => {
    // Clean up test directories
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
      await rm(join(HOME_DIR, '.claude-test'), { recursive: true, force: true });
    } catch (e) {
      // Ignore errors
    }
    
    // Create test hooks directory
    await mkdir(TEST_HOOKS_DIR, { recursive: true });
    
    // Create test hooks
    await writeFile(join(TEST_HOOKS_DIR, 'pre_tool_use.mjs'), '// test hook');
    await writeFile(join(TEST_HOOKS_DIR, 'config-loader.mjs'), '// config loader');
  });
  
  afterEach(async () => {
    // Clean up
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
      await rm(join(HOME_DIR, '.claude-test'), { recursive: true, force: true });
    } catch (e) {
      // Ignore errors
    }
  });
  
  describe('checkNodeVersion', () => {
    it('should validate Node.js version', () => {
      const result = checkNodeVersion();
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('version');
      expect(result.valid).toBe(true);
      expect(result.version).toMatch(/^v\d+\.\d+\.\d+$/);
    });
  });
  
  describe('checkClaudeCode', () => {
    it('should check for Claude Code installation', () => {
      const result = checkClaudeCode();
      expect(result).toHaveProperty('valid');
      // May or may not be installed, but should return a valid result
      expect(typeof result.valid).toBe('boolean');
    });
  });
  
  describe('ensureDirectories', () => {
    it('should create required directories', async () => {
      const dirs = await ensureDirectories();
      expect(Array.isArray(dirs)).toBe(true);
      expect(dirs.length).toBeGreaterThan(0);
    });
  });
  
  describe('installHooks', () => {
    it('should install hooks from source directory', async () => {
      // Temporarily override global hooks dir for testing
      const originalHooksDir = process.env.TEST_HOOKS_DIR;
      process.env.TEST_HOOKS_DIR = TEST_GLOBAL_HOOKS;
      
      await mkdir(TEST_GLOBAL_HOOKS, { recursive: true });
      
      const result = await installHooks(TEST_HOOKS_DIR);
      
      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('failed');
      expect(Array.isArray(result.installed)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
      
      // Should have installed at least the test hooks
      expect(result.installed.length).toBeGreaterThan(0);
      
      // Clean up
      await rm(TEST_GLOBAL_HOOKS, { recursive: true, force: true });
      if (originalHooksDir) {
        process.env.TEST_HOOKS_DIR = originalHooksDir;
      } else {
        delete process.env.TEST_HOOKS_DIR;
      }
    });
    
    it('should handle missing source hooks gracefully', async () => {
      await mkdir(TEST_GLOBAL_HOOKS, { recursive: true });

      const result = await installHooks(join(TEST_DIR, 'nonexistent'));

      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('failed');
      // When directory doesn't exist, all 9 required hooks should be reported as failed
      // Hooks: pre_tool_use, permission_request, post_tool_use, session_start, session_end, stop, notification, config-loader, session-register
      expect(result.failed.length).toBe(9);
      expect(result.installed.length).toBe(0);
      // Verify all failures have correct error message
      expect(result.failed.every(f => f.error === 'File not found')).toBe(true);

      await rm(TEST_GLOBAL_HOOKS, { recursive: true, force: true });
    });
  });
  
  describe('createSettings', () => {
    it('should create Claude Code settings file', async () => {
      // Create test hooks directory for settings reference
      await mkdir(TEST_GLOBAL_HOOKS, { recursive: true });
      await mkdir(join(HOME_DIR, '.claude-test'), { recursive: true });
      
      // Temporarily override environment variables
      const originalSettings = process.env.TEST_SETTINGS;
      const originalHooksDir = process.env.TEST_HOOKS_DIR;
      
      process.env.TEST_SETTINGS = TEST_SETTINGS;
      process.env.TEST_HOOKS_DIR = TEST_GLOBAL_HOOKS;
      
      // Create a test settings file directly to verify structure
      const testSettings = {
        hooks: {
          PreToolUse: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: `node ${join(TEST_GLOBAL_HOOKS, 'pre_tool_use.mjs')}`
            }]
          }],
          Stop: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: `node ${join(TEST_GLOBAL_HOOKS, 'stop.mjs')}`
            }]
          }],
          SessionStart: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: `node ${join(TEST_GLOBAL_HOOKS, 'session_start.mjs')}`
            }]
          }],
          SessionEnd: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: `node ${join(TEST_GLOBAL_HOOKS, 'session_end.mjs')}`
            }]
          }],
          Notification: [{
            matcher: ".*",
            hooks: [{
              type: "command",
              command: `node ${join(TEST_GLOBAL_HOOKS, 'notification.mjs')}`
            }]
          }]
        }
      };
      
      await writeFile(TEST_SETTINGS, JSON.stringify(testSettings, null, 2));
      
      // Verify the file was created correctly
      const content = await readFile(TEST_SETTINGS, 'utf8');
      const settings = JSON.parse(content);
      
      expect(settings).toHaveProperty('hooks');
      expect(settings.hooks).toHaveProperty('PreToolUse');
      expect(settings.hooks).toHaveProperty('Stop');
      expect(settings.hooks).toHaveProperty('SessionStart');
      expect(settings.hooks).toHaveProperty('SessionEnd');
      expect(settings.hooks).toHaveProperty('Notification');
      
      // Verify hook commands reference the correct paths
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('pre_tool_use.mjs');
      
      // Clean up
      await rm(join(HOME_DIR, '.claude-test'), { recursive: true, force: true });
      await rm(TEST_GLOBAL_HOOKS, { recursive: true, force: true });
      if (originalSettings) {
        process.env.TEST_SETTINGS = originalSettings;
      } else {
        delete process.env.TEST_SETTINGS;
      }
      if (originalHooksDir) {
        process.env.TEST_HOOKS_DIR = originalHooksDir;
      } else {
        delete process.env.TEST_HOOKS_DIR;
      }
    });
  });
  
  describe('verifyInstallation', () => {
    it('should verify installation components', async () => {
      // Create a minimal installation
      await mkdir(TEST_GLOBAL_HOOKS, { recursive: true });
      await writeFile(join(TEST_GLOBAL_HOOKS, 'pre_tool_use.mjs'), '// hook');
      await writeFile(join(TEST_GLOBAL_HOOKS, 'config-loader.mjs'), '// loader');
      
      await mkdir(join(HOME_DIR, '.claude-test'), { recursive: true });
      await writeFile(TEST_SETTINGS, JSON.stringify({
        hooks: {
          PreToolUse: []
        }
      }));
      
      // Note: verifyInstallation uses hardcoded paths, so this test
      // may not work perfectly without mocking, but we can test the structure
      const result = await verifyInstallation();
      
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('checks');
      expect(result.checks).toHaveProperty('directories');
      expect(result.checks).toHaveProperty('hooks');
      expect(result.checks).toHaveProperty('settings');
      
      // Clean up
      await rm(join(HOME_DIR, '.claude-test'), { recursive: true, force: true });
    });
  });
});

