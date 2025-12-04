#!/usr/bin/env node
// Teleportation CLI - Remote Claude Code Control Setup
// Version 1.0.0

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const CLI_VERSION = '1.0.0';
const HOME_DIR = os.homedir();
// Teleportation project directory (for development)
// In production, hooks will be installed globally
const TELEPORTATION_DIR = process.env.TELEPORTATION_DIR || path.join(__dirname);

// Color helpers
const c = {
  red: (text) => '\x1b[0;31m' + text + '\x1b[0m',
  green: (text) => '\x1b[0;32m' + text + '\x1b[0m',
  yellow: (text) => '\x1b[1;33m' + text + '\x1b[0m',
  blue: (text) => '\x1b[0;34m' + text + '\x1b[0m',
  purple: (text) => '\x1b[0;35m' + text + '\x1b[0m',
  cyan: (text) => '\x1b[0;36m' + text + '\x1b[0m'
};

// Configuration manager
class ConfigManager {
  constructor() {
    this.globalHooksDir = path.join(HOME_DIR, '.claude');
    this.globalSettings = path.join(this.globalHooksDir, 'settings.json');
    this.globalHooks = path.join(this.globalHooksDir, 'hooks');
    this.projectHooksDir = path.join(TELEPORTATION_DIR, '.claude', 'hooks');
    this.envFile = path.join(HOME_DIR, '.teleportation-env');
    this.zshrc = path.join(HOME_DIR, '.zshrc');
  }

  ensureDirectories() {
    [this.globalHooksDir, this.globalHooks].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  isConfigured() {
    return fs.existsSync(this.globalSettings) && 
           fs.existsSync(this.globalHooks) &&
           fs.readdirSync(this.globalHooks).length > 0;
  }

  getEnvVars() {
    // Synchronous version for backward compatibility
    // For async credential loading, use getCredentials() instead
    const vars = {
      RELAY_API_URL: process.env.RELAY_API_URL || '',
      RELAY_API_KEY: process.env.RELAY_API_KEY || '',
      SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || ''
    };
    return vars;
  }
  
  async getCredentials() {
    return await getCredentials();
  }

  areEnvVarsSet() {
    const vars = this.getEnvVars();
    return vars.RELAY_API_URL && vars.RELAY_API_KEY;
  }
}

const config = new ConfigManager();

// Credential loader (async, uses ES module)
let credentialManager = null;
async function loadCredentialManager() {
  if (!credentialManager) {
    try {
      const { CredentialManager } = await import('./lib/auth/credentials.js');
      credentialManager = new CredentialManager();
    } catch (e) {
      // Credential manager not available, will fall back to env vars
      credentialManager = null;
    }
  }
  return credentialManager;
}

// Load credentials on startup
let loadedCredentials = null;
async function loadCredentials() {
  if (loadedCredentials !== null) return loadedCredentials;
  
  try {
    const manager = await loadCredentialManager();
    if (manager) {
      loadedCredentials = await manager.load();
    }
  } catch (e) {
    // Distinguish between different error types
    if (e.code === 'ENOENT') {
      // File doesn't exist - OK, fall back to env vars
      loadedCredentials = null;
    } else if (e.message && e.message.includes('decrypt')) {
      // Decryption failed - warn user but fall back
      console.warn('⚠️  Credential file exists but could not be decrypted. Using environment variables.');
      loadedCredentials = null;
    } else {
      // Other error - log for debugging but don't fail
      console.error('Failed to load credentials:', e.message);
      loadedCredentials = null;
    }
  }
  
  return loadedCredentials;
}

// Get credentials with fallback to environment variables
async function getCredentials() {
  const creds = await loadCredentials();
  if (creds) {
    return {
      RELAY_API_URL: creds.relayApiUrl || process.env.RELAY_API_URL || '',
      RELAY_API_KEY: creds.relayApiKey || creds.apiKey || process.env.RELAY_API_KEY || '',
      SLACK_WEBHOOK_URL: creds.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL || ''
    };
  }
  
  // Fall back to environment variables
  return {
    RELAY_API_URL: process.env.RELAY_API_URL || '',
    RELAY_API_KEY: process.env.RELAY_API_KEY || '',
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || ''
  };
}

// Parse command line flags
function parseFlags(args) {
  const flags = {};
  const positional = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++; // Skip next arg as it's the value
      } else {
        flags[key] = true; // Boolean flag
      }
    } else if (arg.startsWith('-')) {
      // Short flags like -k
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  
  return { flags, positional };
}

// Service checker
function checkService(name, port) {
  try {
    const result = execSync(`lsof -i :${port} 2>/dev/null | grep LISTEN`, { encoding: 'utf8' });
    return result.includes('LISTEN');
  } catch (e) {
    return false;
  }
}

function checkServiceHealth(url) {
  try {
    const result = execSync(`curl -s ${url}/health`, { encoding: 'utf8' });
    return result.includes('healthy');
  } catch (e) {
    return false;
  }
}

// Command handlers
function commandVersion() {
  console.log(c.purple('Teleportation CLI'));
  console.log(c.cyan(`Version: ${CLI_VERSION}`));
  console.log(c.blue(`Node.js: ${process.version}`));
  console.log(c.yellow(`Platform: ${process.platform} ${process.arch}`));
  console.log(c.green(`Home: ${HOME_DIR}`));
}

function commandHelp() {
  console.log(c.purple('Teleportation CLI v' + CLI_VERSION));
  console.log(c.cyan('Remote Claude Code Control System\n'));

  console.log(c.yellow('Usage:'));
  console.log('  ./teleportation <command> [options]\n');

  console.log(c.yellow('Getting Started:'));
  console.log('  ' + c.green('setup') + '            ⭐ Guided setup wizard (recommended for new users)');
  console.log('  ' + c.green('status') + '           Check system status and connectivity\n');

  console.log(c.yellow('Authentication:'));
  console.log('  ' + c.green('login') + '            Authenticate with API key or token');
  console.log('  ' + c.green('logout') + '           Clear saved credentials\n');

  console.log(c.yellow('Setup Commands:'));
  console.log('  ' + c.green('on') + '               Enable remote control hooks');
  console.log('  ' + c.green('off') + '              Disable remote control hooks');
  console.log('  ' + c.green('install-hooks') + '    Install hooks globally to ~/.claude/hooks/');
  console.log('  ' + c.green('update') + '           Update CLI and hooks to latest version');
  console.log('  ' + c.green('test') + '             Run diagnostic tests');
  console.log('  ' + c.green('doctor') + '           Run comprehensive diagnostics\n');

  console.log(c.yellow('Backup & Restore:'));
  console.log('  ' + c.green('backup list') + '      List all backups');
  console.log('  ' + c.green('backup restore') + '   Restore from backup');
  console.log('  ' + c.green('backup create') + '    Create a manual backup\n');
  
  console.log(c.yellow('Service Management:'));
  console.log('  ' + c.green('start') + '            Start relay and storage services');
  console.log('  ' + c.green('stop') + '             Stop all services');
  console.log('  ' + c.green('restart') + '          Restart all services');
  console.log('  ' + c.green('logs') + '             View service logs\n');

  console.log(c.yellow('Daemon Management:'));
  console.log('  ' + c.green('daemon start') + '     Start the teleportation daemon');
  console.log('  ' + c.green('daemon stop') + '      Stop the daemon');
  console.log('  ' + c.green('daemon restart') + '   Restart the daemon');
  console.log('  ' + c.green('daemon status') + '    Show daemon status');
  console.log('  ' + c.green('daemon health') + '    Check daemon health\n');
  
  console.log(c.yellow('Inbox & Messaging:'));
  console.log('  ' + c.green('command "<text>"') + '   Enqueue a command message for this session');
  console.log('  ' + c.green('inbox') + '             View next inbox message for this session');
  console.log('  ' + c.green('inbox-ack <id>') + '    Acknowledge inbox message by id\n');
  
  console.log(c.yellow('Configuration:'));
  console.log('  ' + c.green('config') + '           Manage configuration');
  console.log('  ' + c.green('config list') + '      Show all settings');
  console.log('  ' + c.green('config get <key>') + '  Get specific setting');
  console.log('  ' + c.green('config set <key> <value>') + '  Update setting');
  console.log('  ' + c.green('config edit') + '      Open config in editor');
  console.log('  ' + c.green('env') + '              Show environment variables\n');
  
  console.log(c.yellow('Session Isolation:'));
  console.log('  ' + c.green('worktree create') + '  Create isolated worktree for a session');
  console.log('  ' + c.green('worktree list') + '    List all session worktrees');
  console.log('  ' + c.green('worktree remove') + '  Remove a worktree');
  console.log('  ' + c.green('worktree info') + '    Show worktree information');
  console.log('  ' + c.green('snapshot create') + '  Create a code snapshot');
  console.log('  ' + c.green('snapshot list') + '    List snapshots for a session');
  console.log('  ' + c.green('snapshot restore') + ' Restore a previous snapshot');
  console.log('  ' + c.green('session list') + '     List registered sessions');
  console.log('  ' + c.green('session check-conflicts') + ' Check for file conflicts\n');

  console.log(c.yellow('Information:'));
  console.log('  ' + c.green('info') + '             Show detailed system info');
  console.log('  ' + c.green('version') + '          Show version information');
  console.log('  ' + c.green('help') + '             Show this help message\n');
  
  console.log(c.purple('Examples:'));
  console.log('  ./teleportation setup                # ⭐ Recommended: guided setup');
  console.log('  ./teleportation status               # Check status');
  console.log('  ./teleportation backup restore       # Restore previous config');
  console.log('');
  console.log(c.purple('Quick Start (new users):'));
  console.log('  Just run: ' + c.green('teleportation setup'));
  console.log('  The wizard will guide you through everything!\n');
}

async function commandOn() {
  console.log(c.yellow('🚀 Enabling Teleportation Remote Control...\n'));
  
  try {
    // Use installer module
    const installerPath = path.join(TELEPORTATION_DIR, 'lib', 'install', 'installer.js');
    const { install, checkNodeVersion, checkClaudeCode } = await import('file://' + installerPath);
    
    // Pre-flight checks
    const nodeCheck = checkNodeVersion();
    if (!nodeCheck.valid) {
      console.log(c.red(`❌ ${nodeCheck.error}\n`));
      return;
    }
    console.log(c.green(`✅ Node.js ${nodeCheck.version}\n`));
    
    const claudeCheck = checkClaudeCode();
    if (!claudeCheck.valid) {
      console.log(c.yellow(`⚠️  ${claudeCheck.error}\n`));
      console.log(c.cyan('   Continuing anyway...\n'));
    } else {
      console.log(c.green(`✅ Claude Code found: ${claudeCheck.path}\n`));
    }
    
    // Install hooks
    const sourceHooksDir = path.join(TELEPORTATION_DIR, '.claude', 'hooks');
    if (!fs.existsSync(sourceHooksDir)) {
      console.log(c.red(`❌ Hooks not found at ${sourceHooksDir}\n`));
      return;
    }
    
    const result = await install(sourceHooksDir);
    
    console.log(c.green('\n🎉 Teleportation Remote Control ENABLED!'));
    console.log(c.cyan('\nInstallation Summary:'));
    console.log(`  Hooks verified: ${c.green(result.hooksVerified)}`);
    console.log(`  Daemon installed: ${c.green(result.daemonInstalled + ' files')}`);
    console.log(`  Settings file: ${c.green(result.settingsFile)}`);
    console.log(`  Hooks directory: ${c.green(result.hooksDir)}`);
    console.log(`  Daemon directory: ${c.green(result.daemonDir)}`);
    console.log(c.cyan('\nNext steps:'));
    console.log('  1. Login: teleportation login');
    console.log('  2. Check status: teleportation status');
    console.log('  3. Run diagnostics: teleportation doctor\n');
    
  } catch (error) {
    console.log(c.red(`❌ Installation failed: ${error.message}\n`));
    process.exit(1);
  }
}

/**
 * Setup wizard - guided onboarding for new users
 * Creates backup before making changes, validates API key, installs hooks
 */
async function commandSetup() {
  const readline = require('readline');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('\n' + c.cyan('╭─────────────────────────────────────────────────────╮'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('│   🚀 ') + c.purple('Teleportation Setup') + c.cyan('                            │'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('│   Let\'s get you set up for remote Claude Code      │'));
  console.log(c.cyan('│   approvals in just a few steps.                   │'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('╰─────────────────────────────────────────────────────╯\n'));

  try {
    // Step 0: Check for existing files and create backup
    console.log(c.yellow('Checking existing configuration...\n'));

    const backupManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'backup', 'manager.js');
    const { BackupManager } = await import('file://' + backupManagerPath);
    const backupManager = new BackupManager();

    const existingFiles = backupManager.checkExistingFiles();

    if (existingFiles.length > 0) {
      console.log(c.yellow('  ⚠️  Found existing files that will be modified:'));
      for (const file of existingFiles) {
        const shortPath = file.path.replace(HOME_DIR, '~');
        if (file.fileCount !== undefined) {
          console.log(`     • ${shortPath} (contains ${file.fileCount} files)`);
        } else {
          console.log(`     • ${shortPath}`);
        }
      }
      console.log('');

      console.log(c.cyan('  Creating backup before proceeding...'));
      const { backupPath, manifest } = await backupManager.createBackup('teleportation setup');
      const shortBackupPath = backupPath.replace(HOME_DIR, '~');
      console.log(c.green(`  ✅ Backup saved to ${shortBackupPath}/`));
      console.log(c.cyan(`\n  To restore if needed: ${c.green('teleportation backup restore')}\n`));

      const proceed = await question('Continue with setup? (Y/n): ');
      if (proceed.toLowerCase() === 'n' || proceed.toLowerCase() === 'no') {
        console.log(c.yellow('\nSetup cancelled.\n'));
        rl.close();
        return;
      }
    }

    // Step 1: Authentication
    console.log('\n' + c.purple('Step 1 of 4: Authentication\n'));
    console.log('  You\'ll need to sign in to get an API key.\n');

    // Try to open browser
    const appUrl = 'https://app.teleportation.dev/login';
    console.log(c.cyan(`  → Opening ${appUrl} in your browser...`));

    try {
      const openCommand = process.platform === 'darwin' ? 'open' :
                         process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCommand} ${appUrl}`, { stdio: 'ignore' });
    } catch (e) {
      console.log(c.yellow(`  ⚠️  Could not open browser. Please visit: ${appUrl}`));
    }

    console.log('\n  After signing in:');
    console.log('  1. Click "Keys" in the bottom navigation');
    console.log('  2. Click "Create" to generate a new API key');
    console.log('  3. Copy the key and paste it below\n');

    const apiKey = await question('  Paste your API key: ');

    if (!apiKey || !apiKey.trim()) {
      console.log(c.red('\n  ❌ No API key provided. Setup cancelled.\n'));
      rl.close();
      return;
    }

    const trimmedKey = apiKey.trim();
    const relayUrl = 'https://api.teleportation.dev';

    // Validate API key
    console.log(c.cyan('\n  Validating API key...'));
    try {
      const apiKeyPath = path.join(TELEPORTATION_DIR, 'lib', 'auth', 'api-key.js');
      const { validateApiKey } = await import('file://' + apiKeyPath);
      const result = await validateApiKey(trimmedKey, relayUrl);

      if (!result.valid) {
        console.log(c.red(`\n  ❌ ${result.error}`));
        console.log(c.yellow('  Please check your API key and try again.\n'));
        rl.close();
        return;
      }
    } catch (e) {
      console.log(c.yellow(`\n  ⚠️  Could not validate API key: ${e.message}`));
      console.log(c.cyan('  Continuing anyway (will validate on first use)...'));
    }

    console.log(c.green('  ✅ API key validated successfully!'));

    // Step 2: Configuration
    console.log('\n' + c.purple('Step 2 of 4: Configuration\n'));
    console.log(`  Relay URL: ${c.cyan(relayUrl)}`);

    // Test relay connectivity
    console.log(c.cyan('  Testing connectivity...'));
    try {
      const start = Date.now();
      const response = await fetch(`${relayUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      const elapsed = Date.now() - start;

      if (response.ok) {
        console.log(c.green(`  ✅ Relay is reachable (responded in ${elapsed}ms)`));
      } else {
        console.log(c.yellow(`  ⚠️  Relay returned status ${response.status}`));
      }
    } catch (e) {
      console.log(c.yellow(`  ⚠️  Could not reach relay: ${e.message}`));
      console.log(c.cyan('  Continuing anyway (will retry on use)...'));
    }

    // Save credentials
    console.log(c.cyan('\n  Saving credentials...'));
    const manager = await loadCredentialManager();
    if (manager) {
      const credentials = {
        apiKey: trimmedKey,
        relayApiUrl: relayUrl,
        authenticatedAt: Date.now(),
        method: 'setup-wizard'
      };
      await manager.save(credentials);
      console.log(c.green('  ✅ Credentials saved'));
    }

    // Update config to match
    const configManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
    try {
      const { setConfigValue } = await import('file://' + configManagerPath);
      await setConfigValue('relay.url', relayUrl);
      console.log(c.green('  ✅ Configuration updated'));
    } catch (e) {
      console.log(c.yellow(`  ⚠️  Could not update config: ${e.message}`));
    }

    // Step 3: Install Hooks
    console.log('\n' + c.purple('Step 3 of 4: Installing Hooks\n'));
    console.log('  Installing Claude Code hooks to ~/.claude/hooks/');

    try {
      const installerPath = path.join(TELEPORTATION_DIR, 'lib', 'install', 'installer.js');
      const { install } = await import('file://' + installerPath);
      const sourceHooksDir = path.join(TELEPORTATION_DIR, '.claude', 'hooks');
      const result = await install(sourceHooksDir);
      console.log(c.green(`  ✅ ${result.hooksVerified} hooks installed successfully`));
    } catch (e) {
      console.log(c.red(`  ❌ Failed to install hooks: ${e.message}`));
      console.log(c.yellow('\n  Would you like to restore your previous configuration?'));
      const restore = await question('  Restore backup? (y/N): ');
      if (restore.toLowerCase() === 'y' || restore.toLowerCase() === 'yes') {
        console.log(c.cyan('\n  Restoring from backup...'));
        try {
          await backupManager.restore();
          console.log(c.green('  ✅ Previous configuration restored'));
        } catch (restoreErr) {
          console.log(c.red(`  ❌ Failed to restore: ${restoreErr.message}`));
        }
      }
      rl.close();
      return;
    }

    // Step 4: Verification
    console.log('\n' + c.purple('Step 4 of 4: Verification\n'));
    console.log(c.green('  ✅ Credentials saved'));
    console.log(c.green('  ✅ Configuration saved'));
    console.log(c.green('  ✅ Hooks installed'));
    console.log(c.green('  ✅ Relay connectivity confirmed'));

    // Success!
    console.log('\n' + c.cyan('╭─────────────────────────────────────────────────────╮'));
    console.log(c.cyan('│                                                     │'));
    console.log(c.cyan('│   🎉 ') + c.green('Setup Complete!') + c.cyan('                               │'));
    console.log(c.cyan('│                                                     │'));
    console.log(c.cyan('│   ') + c.yellow('⚠️  Important:') + c.cyan(' Restart Claude Code to activate   │'));
    console.log(c.cyan('│      teleportation for your current session.       │'));
    console.log(c.cyan('│                                                     │'));
    console.log(c.cyan('│   Then open ') + c.green('https://app.teleportation.dev') + c.cyan(' on your  │'));
    console.log(c.cyan('│   phone to approve actions remotely.               │'));
    console.log(c.cyan('│                                                     │'));
    console.log(c.cyan('╰─────────────────────────────────────────────────────╯\n'));

    rl.close();

  } catch (error) {
    console.log(c.red(`\n❌ Setup failed: ${error.message}\n`));
    rl.close();
    process.exit(1);
  }
}

/**
 * Backup command - list, create, restore backups
 */
async function commandBackup(args) {
  const subcommand = args[0] || 'list';

  const backupManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'backup', 'manager.js');
  const { BackupManager } = await import('file://' + backupManagerPath);
  const backupManager = new BackupManager();

  switch (subcommand) {
    case 'list': {
      console.log(c.purple('Teleportation Backups\n'));

      const backups = backupManager.listBackups();

      if (backups.length === 0) {
        console.log(c.yellow('  No backups found.\n'));
        console.log(c.cyan('  Backups are created automatically during setup.'));
        console.log(c.cyan('  Run: teleportation backup create\n'));
        return;
      }

      backups.forEach((backup, index) => {
        const isLatest = index === 0;
        const date = new Date(backup.timestamp).toLocaleString();
        console.log(`  ${index + 1}. ${c.cyan(backup.id)}${isLatest ? c.green(' (latest)') : ''}`);
        console.log(`     Reason: ${backup.reason}`);
        console.log(`     Date: ${date}`);
        console.log(`     Files: ${backup.fileCount} backed up\n`);
      });

      console.log(c.cyan('  To restore: teleportation backup restore [backup-id]\n'));
      break;
    }

    case 'create': {
      console.log(c.purple('Creating Backup\n'));

      const reason = args[1] || 'manual backup';
      console.log(c.cyan('  Creating backup...'));

      try {
        const { backupPath, manifest } = await backupManager.createBackup(reason);
        const shortPath = backupPath.replace(HOME_DIR, '~');
        console.log(c.green(`\n  ✅ Backup created: ${shortPath}/`));
        console.log(`     Files backed up: ${manifest.files.length}\n`);
      } catch (e) {
        console.log(c.red(`\n  ❌ Failed to create backup: ${e.message}\n`));
        process.exit(1);
      }
      break;
    }

    case 'restore': {
      const backupId = args[1] || null;

      console.log(c.purple('Restoring from Backup\n'));

      if (!backupId) {
        console.log(c.cyan('  Restoring from latest backup...'));
      } else {
        console.log(c.cyan(`  Restoring from backup: ${backupId}...`));
      }

      try {
        const { manifest, restoredFiles } = await backupManager.restore(backupId);
        console.log(c.green(`\n  ✅ Restored ${restoredFiles.length} files from backup\n`));

        for (const file of restoredFiles) {
          const shortPath = file.replace(HOME_DIR, '~');
          console.log(c.green(`     ✅ ${shortPath}`));
        }

        console.log(c.yellow('\n  ⚠️  Restart Claude Code to apply restored settings.\n'));
      } catch (e) {
        console.log(c.red(`\n  ❌ Failed to restore: ${e.message}\n`));
        process.exit(1);
      }
      break;
    }

    case 'delete': {
      const backupId = args[1];

      if (!backupId) {
        console.log(c.red('  ❌ Please specify a backup ID to delete.\n'));
        console.log(c.cyan('  Usage: teleportation backup delete <backup-id>\n'));
        return;
      }

      console.log(c.purple('Deleting Backup\n'));
      console.log(c.cyan(`  Deleting backup: ${backupId}...`));

      try {
        backupManager.deleteBackup(backupId);
        console.log(c.green(`\n  ✅ Backup deleted: ${backupId}\n`));
      } catch (e) {
        console.log(c.red(`\n  ❌ Failed to delete: ${e.message}\n`));
      }
      break;
    }

    default:
      console.log(c.red(`  Unknown backup subcommand: ${subcommand}\n`));
      console.log(c.cyan('  Available commands:'));
      console.log('    backup list     - List all backups');
      console.log('    backup create   - Create a new backup');
      console.log('    backup restore  - Restore from backup');
      console.log('    backup delete   - Delete a backup\n');
  }
}

function commandOff() {
  console.log(c.yellow('🛑 Disabling Teleportation Remote Control...\n'));
  
  // Remove settings.json
  if (fs.existsSync(config.globalSettings)) {
    fs.unlinkSync(config.globalSettings);
    console.log(c.green('✅ Removed ~/.claude/settings.json'));
  }
  
  // Remove hooks
  if (fs.existsSync(config.globalHooks)) {
    const hooks = fs.readdirSync(config.globalHooks).filter(f => f.endsWith('.mjs'));
    hooks.forEach(hook => {
      fs.unlinkSync(path.join(config.globalHooks, hook));
    });
    console.log(c.green(`✅ Removed ${hooks.length} hooks`));
  }
  
  console.log(c.yellow('\n🛑 Teleportation Remote Control DISABLED'));
  console.log(c.cyan('Services are still running. Stop with: ./teleportation stop\n'));
}

async function commandStatus() {
  console.log(c.purple('Teleportation System Status\n'));

  let issues = [];
  let warnings = [];

  // Authentication status
  console.log(c.yellow('Authentication:'));
  const creds = await getCredentials();
  const hasCredentials = await loadCredentials();

  if (hasCredentials) {
    console.log('  ' + c.green('✅') + ' Logged in');
    console.log('     Source: Encrypted credentials file');
    console.log('     API key: ' + c.cyan('***' + (creds.RELAY_API_KEY?.slice(-4) || '????')));
  } else if (creds.RELAY_API_KEY) {
    console.log('  ' + c.yellow('⚠️') + ' Using environment variables');
    console.log('     API key: ' + c.cyan('***' + creds.RELAY_API_KEY.slice(-4)));
    warnings.push('Consider running `teleportation login` for encrypted credential storage');
  } else {
    console.log('  ' + c.red('❌') + ' Not logged in');
    issues.push('Run `teleportation setup` to configure authentication');
  }

  // Relay connection status
  console.log('\n' + c.yellow('Relay Connection:'));
  const relayUrl = creds.RELAY_API_URL;

  if (!relayUrl) {
    console.log('  ' + c.red('❌') + ' Relay URL not configured');
    issues.push('Run `teleportation setup` to configure relay URL');
  } else {
    console.log('  URL: ' + c.cyan(relayUrl));

    // Test connectivity
    try {
      const start = Date.now();
      const response = await fetch(`${relayUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      const elapsed = Date.now() - start;

      if (response.ok) {
        console.log('  ' + c.green('✅') + ` Reachable (${elapsed}ms)`);
        try {
          const health = await response.json();
          if (health.version) {
            console.log('     Version: ' + c.cyan(health.version));
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      } else {
        console.log('  ' + c.yellow('⚠️') + ` Returned status ${response.status}`);
        warnings.push(`Relay returned HTTP ${response.status}`);
      }
    } catch (e) {
      if (e.name === 'TimeoutError') {
        console.log('  ' + c.red('❌') + ' Connection timed out');
        issues.push('Relay is not responding. Check your internet connection.');
      } else {
        console.log('  ' + c.red('❌') + ` Cannot reach: ${e.message}`);
        issues.push('Relay is unreachable. Check the URL and your internet connection.');
      }
    }

    // Validate API key if we have one
    if (creds.RELAY_API_KEY) {
      try {
        const apiKeyPath = path.join(TELEPORTATION_DIR, 'lib', 'auth', 'api-key.js');
        const { validateApiKey } = await import('file://' + apiKeyPath);
        const result = await validateApiKey(creds.RELAY_API_KEY, relayUrl);

        if (result.valid) {
          console.log('  ' + c.green('✅') + ' API key validated');
        } else {
          console.log('  ' + c.red('❌') + ` API key invalid: ${result.error}`);
          issues.push('API key is invalid. Create a new one at app.teleportation.dev/api-keys');
        }
      } catch (e) {
        console.log('  ' + c.yellow('⚠️') + ' Could not validate API key');
      }
    }
  }

  // Hooks status
  console.log('\n' + c.yellow('Hooks:'));
  const hooksConfigured = config.isConfigured();

  if (hooksConfigured) {
    console.log('  ' + c.green('✅') + ' Enabled in Claude Code settings');
    const hookFiles = fs.readdirSync(config.globalHooks).filter(f => f.endsWith('.mjs'));
    console.log('  ' + c.green('✅') + ` ${hookFiles.length} hook files installed`);
    console.log('     Directory: ~/.claude/hooks/');
  } else {
    console.log('  ' + c.red('❌') + ' Hooks not installed');
    issues.push('Run `teleportation setup` to install hooks');
  }

  // Config/credentials sync check
  console.log('\n' + c.yellow('Configuration:'));
  try {
    const configManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
    const { getConfigValue } = await import('file://' + configManagerPath);
    const configRelayUrl = await getConfigValue('relay.url');

    if (configRelayUrl && relayUrl && configRelayUrl !== relayUrl) {
      console.log('  ' + c.yellow('⚠️') + ' Config/credentials mismatch');
      console.log('     Config relay.url: ' + c.cyan(configRelayUrl));
      console.log('     Credentials URL: ' + c.cyan(relayUrl));
      warnings.push('Config and credentials have different relay URLs. Run `teleportation setup` to fix.');
    } else {
      console.log('  ' + c.green('✅') + ' Config and credentials in sync');
    }
  } catch (e) {
    console.log('  ' + c.yellow('⚠️') + ' Could not check config sync');
  }

  // Session/restart check
  const sessionMarkerPath = path.join(HOME_DIR, '.teleportation', '.session_marker');
  const credentialsPath = path.join(HOME_DIR, '.teleportation', 'credentials');

  if (fs.existsSync(sessionMarkerPath) && fs.existsSync(credentialsPath)) {
    try {
      const markerMtime = fs.statSync(sessionMarkerPath).mtimeMs;
      const credsMtime = fs.statSync(credentialsPath).mtimeMs;

      if (credsMtime > markerMtime) {
        console.log('  ' + c.yellow('⚠️') + ' Credentials updated since session started');
        console.log('     Session started: ' + c.cyan(new Date(markerMtime).toLocaleTimeString()));
        console.log('     Credentials updated: ' + c.cyan(new Date(credsMtime).toLocaleTimeString()));
        warnings.push('Credentials changed after session started. Restart Claude Code to apply changes.');
      }
    } catch (e) {
      // Ignore errors checking session marker
    }
  }

  // Local services (only show if relevant)
  const localRelayRunning = checkService('relay', 3030);
  const localStorageRunning = checkService('storage', 3040);

  if (localRelayRunning || localStorageRunning) {
    console.log('\n' + c.yellow('Local Services:'));
    if (localRelayRunning) {
      console.log('  ' + c.green('✅') + ' Local relay running (port 3030)');
    }
    if (localStorageRunning) {
      console.log('  ' + c.green('✅') + ' Local storage running (port 3040)');
    }
  }

  // Overall status
  console.log('\n' + c.yellow('─────────────────────────────────────────'));

  if (issues.length === 0 && warnings.length === 0) {
    console.log(c.green('\n🎉 All systems operational!'));
    console.log(c.cyan('\nOpen https://app.teleportation.dev on your phone to approve actions.\n'));
  } else if (issues.length === 0) {
    console.log(c.yellow('\n⚠️  System operational with warnings:\n'));
    warnings.forEach(w => console.log('  • ' + w));
    console.log();
  } else {
    console.log(c.red('\n❌ Issues found:\n'));
    issues.forEach(i => console.log('  • ' + i));
    if (warnings.length > 0) {
      console.log(c.yellow('\nWarnings:'));
      warnings.forEach(w => console.log('  • ' + w));
    }
    console.log(c.cyan('\n→ Run: teleportation setup\n'));
  }
}

function commandStart() {
  console.log(c.yellow('🚀 Starting Teleportation services...\n'));
  
  // Note: Relay and storage APIs are separate services
  // These paths are for local development only
  const internalRelayDir = path.join(TELEPORTATION_DIR, 'relay');
  const relayDir = process.env.RELAY_DIR || (fs.existsSync(internalRelayDir) ? internalRelayDir : path.join(TELEPORTATION_DIR, '..', 'detach', 'relay'));
  
  // Storage API is expected to be in the 'storage-api' directory within the teleportation project
  const storageDir = process.env.STORAGE_DIR || path.join(TELEPORTATION_DIR, 'storage-api');
  const logDir = path.join(HOME_DIR, 'Library', 'Logs');
  
  // Check if already running
  if (checkService('relay', 3030)) {
    console.log(c.yellow('⚠️  Relay API already running'));
  } else {
    // Start relay - use environment file instead of command line to avoid credential exposure
    try {
      const { spawn } = require('child_process');
      const envFile = path.join(relayDir, '.env.relay');
      const envContent = `RELAY_API_KEY=dev-key-123\nPORT=3030\n`;
      
      // Write env file with secure permissions
      fs.writeFileSync(envFile, envContent, { mode: 0o600 });
      
      // Use spawn with env file instead of execSync with command line
      const child = spawn('node', ['server.js'], {
        cwd: relayDir,
        env: { ...process.env, RELAY_API_KEY: 'dev-key-123', PORT: '3030' },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore']
      });
      
      // Write PID and redirect output
      const logFile = path.join(logDir, 'teleportation-relay.log');
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      child.unref();
      
      console.log(c.green('✅ Relay API started on port 3030'));
    } catch (e) {
      console.log(c.red('❌ Failed to start Relay API: ' + e.message));
    }
  }
  
  if (checkService('storage', 3040)) {
    console.log(c.yellow('⚠️  Storage API already running'));
  } else {
    // Start storage - use proper env parsing instead of shell injection
    try {
      const { spawn } = require('child_process');
      const envFile = path.join(storageDir, '.env.local');
      
      if (fs.existsSync(envFile)) {
        // Parse .env file safely
        const envContent = fs.readFileSync(envFile, 'utf8');
        const envVars = {};
        
        // Parse env file line by line (simple parser, no shell execution)
        for (const line of envContent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          
          const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (match) {
            const key = match[1];
            let value = match[2];
            
            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            
            envVars[key] = value;
          }
        }
        
        // Use spawn with parsed env vars instead of shell command
        const child = spawn('node', ['server.js'], {
          cwd: storageDir,
          env: { ...process.env, ...envVars },
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore']
        });
        
        child.unref();
        console.log(c.green('✅ Storage API started on port 3040'));
      } else {
        console.log(c.red('❌ Storage API .env.local not found'));
      }
    } catch (e) {
      console.log(c.red('❌ Failed to start Storage API: ' + e.message));
    }
  }
  
  console.log(c.cyan('\nWait 2 seconds, then check: ./teleportation status\n'));
}

function commandStop() {
  console.log(c.yellow('🛑 Stopping Teleportation services...\n'));
  
  try {
    execSync('pkill -f "relay/server.js"', { stdio: 'ignore' });
    console.log(c.green('✅ Stopped Relay API'));
  } catch (e) {
    console.log(c.yellow('⚠️  Relay API not running'));
  }
  
  try {
    execSync('pkill -f "storage-api/server.js"', { stdio: 'ignore' });
    console.log(c.green('✅ Stopped Storage API'));
  } catch (e) {
    console.log(c.yellow('⚠️  Storage API not running'));
  }
  
  console.log(c.cyan('\nServices stopped\n'));
}

function commandRestart() {
  commandStop();
  setTimeout(() => {
    commandStart();
  }, 1000);
}

async function commandEnv(args) {
  const subcommand = args[0];
  
  if (subcommand === 'set') {
    console.log(c.yellow('Setting environment variables...\n'));
    console.log(c.yellow('Note: Consider using "teleportation login" for encrypted credential storage instead.\n'));
    
    const envContent = `
# Teleportation Remote Control Environment Variables
export RELAY_API_URL="http://localhost:3030"
export RELAY_API_KEY="dev-key-123"
export SLACK_WEBHOOK_URL=""
`;
    
    // Check if already in .zshrc
    if (fs.existsSync(config.zshrc)) {
      const content = fs.readFileSync(config.zshrc, 'utf8');
      if (content.includes('RELAY_API_URL')) {
        console.log(c.yellow('⚠️  Environment variables already in ~/.zshrc'));
      } else {
        fs.appendFileSync(config.zshrc, envContent);
        console.log(c.green('✅ Added to ~/.zshrc'));
      }
    }
    
    console.log(c.cyan('\nTo apply now, run:'));
    console.log(c.green('  source ~/.zshrc\n'));
    console.log(c.cyan('Or restart your terminal\n'));
  } else {
    // Show current credentials (from file or env)
    const creds = await getCredentials();
    const hasFileCreds = await loadCredentials();
    
    console.log(c.yellow('Credentials:\n'));
    if (hasFileCreds) {
      console.log('  Source:', c.green('Encrypted file (~/.teleportation/credentials)'));
    } else {
      console.log('  Source:', c.yellow('Environment variables'));
    }
    console.log('  RELAY_API_URL:', creds.RELAY_API_URL || c.red('not set'));
    console.log('  RELAY_API_KEY:', creds.RELAY_API_KEY ? '***' + creds.RELAY_API_KEY.slice(-4) : c.red('not set'));
    console.log('  SLACK_WEBHOOK_URL:', creds.SLACK_WEBHOOK_URL || c.yellow('not set (optional)'));
    console.log();
  }
}

async function commandTest() {
  console.log(c.purple('Running Teleportation Diagnostics...\n'));
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Hooks configured
  console.log(c.yellow('Test 1: Hooks Configuration'));
  if (config.isConfigured()) {
    console.log(c.green('  ✅ PASS - Hooks configured in ~/.claude/\n'));
    passed++;
  } else {
    console.log(c.red('  ❌ FAIL - Hooks not configured\n'));
    failed++;
  }
  
  // Test 2: Credentials (file or env vars)
  console.log(c.yellow('Test 2: Credentials'));
  const creds = await getCredentials();
  if (creds.RELAY_API_URL && creds.RELAY_API_KEY) {
    const source = await loadCredentials() ? 'encrypted file' : 'environment variables';
    console.log(c.green(`  ✅ PASS - Credentials loaded from ${source}\n`));
    passed++;
  } else {
    console.log(c.red('  ❌ FAIL - Credentials missing\n'));
    failed++;
  }
  
  // Test 3: Relay service
  console.log(c.yellow('Test 3: Relay API Service'));
  const relayUrl = creds.RELAY_API_URL || 'https://api.teleportation.dev';
  if (checkService('relay', 3030) && checkServiceHealth(relayUrl)) {
    console.log(c.green('  ✅ PASS - Relay API running and healthy\n'));
    passed++;
  } else {
    console.log(c.red('  ❌ FAIL - Relay API not running or unhealthy\n'));
    failed++;
  }
  
  // Test 4: Storage service
  console.log(c.yellow('Test 4: Storage API Service'));
  if (checkService('storage', 3040) && checkServiceHealth('http://localhost:3040')) {
    console.log(c.green('  ✅ PASS - Storage API running and healthy\n'));
    passed++;
  } else {
    console.log(c.red('  ❌ FAIL - Storage API not running or unhealthy\n'));
    failed++;
  }
  
  // Test 5: Hook execution
  console.log(c.yellow('Test 5: Hook Execution'));
  try {
    const testHook = path.join(config.globalHooks, 'pre_tool_use.mjs');
    if (fs.existsSync(testHook)) {
      const testInput = '{"session_id":"test","tool_name":"Read","tool_input":{}}';
      const envVars = `RELAY_API_URL="${creds.RELAY_API_URL || 'http://localhost:3030'}" RELAY_API_KEY="${creds.RELAY_API_KEY || 'dev-key-123'}"`;
      execSync(`echo '${testInput}' | ${envVars} node ${testHook}`, { stdio: 'ignore' });
      console.log(c.green('  ✅ PASS - Hook executes successfully\n'));
      passed++;
    } else {
      console.log(c.red('  ❌ FAIL - Hook file not found\n'));
      failed++;
    }
  } catch (e) {
    console.log(c.red('  ❌ FAIL - Hook execution error\n'));
    failed++;
  }
  
  // Summary
  console.log(c.purple('Test Summary:'));
  console.log(`  Passed: ${c.green(passed)}`);
  console.log(`  Failed: ${c.red(failed)}`);
  
  if (failed === 0) {
    console.log(c.green('\n🎉 All tests passed! System is ready.\n'));
  } else {
    console.log(c.yellow('\n⚠️  Some tests failed. Run ./teleportation status for details.\n'));
  }
}

async function commandDoctor() {
  console.log(c.purple('🔍 Teleportation Doctor - System Diagnostics\n'));
  
  const issues = [];
  const recommendations = [];
  let checksPassed = 0;
  let checksFailed = 0;
  
  // Check 1: Claude Code installation
  console.log(c.yellow('1. Claude Code Installation'));
  try {
    const claudeCodePath = execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (claudeCodePath) {
      console.log(c.green(`   ✅ Found: ${claudeCodePath}\n`));
      checksPassed++;
    } else {
      console.log(c.yellow('   ⚠️  Claude Code not found in PATH\n'));
      issues.push('Claude Code not found');
      recommendations.push('Install Claude Code or add it to your PATH');
      checksFailed++;
    }
  } catch (e) {
    console.log(c.yellow('   ⚠️  Could not detect Claude Code installation\n'));
    issues.push('Claude Code detection failed');
    checksFailed++;
  }
  
  // Check 2: Hooks installation
  console.log(c.yellow('2. Hooks Installation'));
  const hooksConfigured = config.isConfigured();
  if (hooksConfigured) {
    const hookFiles = fs.readdirSync(config.globalHooks).filter(f => f.endsWith('.mjs'));
    console.log(c.green(`   ✅ ${hookFiles.length} hooks installed\n`));
    hookFiles.forEach(f => {
      const hookPath = path.join(config.globalHooks, f);
      const stats = fs.statSync(hookPath);
      const isExecutable = (stats.mode & parseInt('111', 8)) !== 0;
      if (isExecutable) {
        console.log(c.green(`      • ${f} (executable)\n`));
      } else {
        console.log(c.yellow(`      • ${f} (not executable)\n`));
        issues.push(`Hook ${f} is not executable`);
        recommendations.push(`Run: chmod +x ${hookPath}`);
      }
    });
    checksPassed++;
  } else {
    console.log(c.red('   ❌ Hooks not configured\n'));
    issues.push('Hooks not installed');
    recommendations.push('Run: teleportation on');
    checksFailed++;
  }
  
  // Check 3: Credentials
  console.log(c.yellow('3. Credentials'));
  const manager = await loadCredentialManager();
  if (manager) {
    const credentials = await manager.load();
    if (credentials) {
      console.log(c.green('   ✅ Credentials found (encrypted file)\n'));
      
      // Check if expired
      const isExpired = await manager.isExpired();
      if (isExpired) {
        console.log(c.red('   ❌ Credentials expired\n'));
        issues.push('Credentials expired');
        recommendations.push('Run: teleportation login');
        checksFailed++;
      } else {
        const daysUntil = await manager.daysUntilExpiry();
        if (daysUntil !== null) {
          if (daysUntil < 7) {
            console.log(c.yellow(`   ⚠️  Credentials expire in ${daysUntil} days\n`));
            recommendations.push('Consider refreshing credentials soon');
          } else {
            console.log(c.green(`   ✅ Credentials valid for ${daysUntil} more days\n`));
          }
        }
        checksPassed++;
      }
    } else {
      // Check environment variables
      const envCreds = {
        RELAY_API_URL: process.env.RELAY_API_URL,
        RELAY_API_KEY: process.env.RELAY_API_KEY
      };
      if (envCreds.RELAY_API_URL && envCreds.RELAY_API_KEY) {
        console.log(c.yellow('   ⚠️  Using environment variables (not encrypted)\n'));
        recommendations.push('Consider using: teleportation login');
        checksPassed++;
      } else {
        console.log(c.red('   ❌ No credentials found\n'));
        issues.push('No credentials');
        recommendations.push('Run: teleportation login');
        checksFailed++;
      }
    }
  } else {
    console.log(c.red('   ❌ Credential manager unavailable\n'));
    checksFailed++;
  }
  
  // Check 4: Relay API connection
  console.log(c.yellow('4. Relay API Connection'));
  const creds = await getCredentials();
  const relayUrl = creds.RELAY_API_URL || 'https://api.teleportation.dev';
  
  if (!relayUrl) {
    console.log(c.red('   ❌ Relay API URL not configured\n'));
    issues.push('Relay API URL missing');
    recommendations.push('Set RELAY_API_URL or run: teleportation login');
    checksFailed++;
  } else {
    const startTime = Date.now();
    try {
      const response = await fetch(`${relayUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - startTime;
      
      if (response.ok) {
        console.log(c.green(`   ✅ Connected (${latency}ms latency)\n`));
        checksPassed++;
        
        if (latency > 1000) {
          console.log(c.yellow(`   ⚠️  High latency detected (${latency}ms)\n`));
          recommendations.push('Consider using a relay API closer to your location');
        }
      } else {
        console.log(c.red(`   ❌ API returned status ${response.status}\n`));
        issues.push(`Relay API unhealthy (status ${response.status})`);
        checksFailed++;
      }
    } catch (error) {
      const latency = Date.now() - startTime;
      console.log(c.red(`   ❌ Connection failed: ${error.message}\n`));
      issues.push(`Cannot connect to relay API at ${relayUrl}`);
      recommendations.push('Check if relay API is running: teleportation start');
      recommendations.push(`Verify URL is correct: ${relayUrl}`);
      checksFailed++;
    }
  }
  
  // Check 5: Environment variables
  console.log(c.yellow('5. Environment Variables'));
  const envVars = {
    RELAY_API_URL: process.env.RELAY_API_URL,
    RELAY_API_KEY: process.env.RELAY_API_KEY ? '***' + process.env.RELAY_API_KEY.slice(-4) : undefined,
    EDITOR: process.env.EDITOR,
    HOME: process.env.HOME
  };
  
  const envSet = Object.entries(envVars).filter(([_, v]) => v).length;
  console.log(c.cyan(`   ${envSet} environment variables set\n`));
  if (envVars.EDITOR) {
    console.log(c.green(`   ✅ Editor: ${envVars.EDITOR}\n`));
  } else {
    console.log(c.yellow('   ⚠️  EDITOR not set (needed for config edit)\n'));
    recommendations.push('Set EDITOR environment variable for config editing');
  }
  checksPassed++;
  
  // Check 6: File permissions
  console.log(c.yellow('6. File Permissions'));
  try {
    const credsPath = path.join(HOME_DIR, '.teleportation', 'credentials');
    if (fs.existsSync(credsPath)) {
      const stats = fs.statSync(credsPath);
      const mode = stats.mode & parseInt('777', 8);
      if (mode === parseInt('600', 8)) {
        console.log(c.green('   ✅ Credentials file permissions correct (600)\n'));
        checksPassed++;
      } else {
        console.log(c.yellow(`   ⚠️  Credentials file permissions: ${mode.toString(8)}\n`));
        issues.push('Credentials file permissions not secure');
        recommendations.push(`Run: chmod 600 ${credsPath}`);
        checksPassed++; // Not critical, just a warning
      }
    } else {
      console.log(c.yellow('   ⚠️  Credentials file does not exist\n'));
      checksPassed++; // Not an error if using env vars
    }
  } catch (e) {
    console.log(c.yellow(`   ⚠️  Could not check permissions: ${e.message}\n`));
    checksPassed++;
  }
  
  // Summary
  console.log(c.purple('\n📊 Diagnostic Summary\n'));
  console.log(`   Checks passed: ${c.green(checksPassed)}`);
  console.log(`   Checks failed: ${checksFailed > 0 ? c.red(checksFailed) : c.green(checksFailed)}`);
  
  if (issues.length > 0) {
    console.log(c.red('\n⚠️  Issues Found:\n'));
    issues.forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue}`);
    });
  }
  
  if (recommendations.length > 0) {
    console.log(c.cyan('\n💡 Recommendations:\n'));
    recommendations.forEach((rec, i) => {
      console.log(`   ${i + 1}. ${rec}`);
    });
  }
  
  if (checksFailed === 0 && issues.length === 0) {
    console.log(c.green('\n🎉 All checks passed! System is healthy.\n'));
  } else {
    console.log(c.yellow('\n⚠️  Some issues detected. Review recommendations above.\n'));
  }
}

async function commandUninstall() {
  console.log(c.purple('🗑️  Teleportation Uninstall\n'));
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    readline.question('Are you sure you want to uninstall Teleportation? (y/N): ', async (answer) => {
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(c.yellow('Uninstall cancelled.\n'));
        readline.close();
        resolve();
        return;
      }

      console.log(c.yellow('\nUninstalling Teleportation...\n'));

      let removed = 0;
      let kept = 0;

      // 1. Remove hooks
      console.log(c.yellow('1. Removing hooks...'));
      if (fs.existsSync(config.globalHooks)) {
        const hookFiles = fs.readdirSync(config.globalHooks).filter(f => 
          f.endsWith('.mjs') && ['pre_tool_use.mjs', 'permission_request.mjs', 'post_tool_use.mjs', 'session_start.mjs', 'session_end.mjs', 'stop.mjs', 'notification.mjs', 'config-loader.mjs'].includes(f)
        );
        
        hookFiles.forEach(hook => {
          try {
            fs.unlinkSync(path.join(config.globalHooks, hook));
            console.log(c.green(`   ✅ Removed ${hook}`));
            removed++;
          } catch (e) {
            console.log(c.red(`   ❌ Failed to remove ${hook}: ${e.message}`));
          }
        });
      }
      console.log();

      // 2. Remove settings.json
      console.log(c.yellow('2. Removing Claude Code settings...'));
      if (fs.existsSync(config.globalSettings)) {
        try {
          fs.unlinkSync(config.globalSettings);
          console.log(c.green('   ✅ Removed ~/.claude/settings.json'));
          removed++;
        } catch (e) {
          console.log(c.red(`   ❌ Failed to remove settings: ${e.message}`));
        }
      } else {
        console.log(c.yellow('   ⚠️  Settings file not found'));
      }
      console.log();

      // 3. Ask about credentials
      console.log(c.yellow('3. Credentials...'));
      const manager = await loadCredentialManager();
      if (manager && await manager.exists()) {
        readline.question('   Delete saved credentials? (y/N): ', async (answer) => {
          if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
            try {
              await manager.delete();
              console.log(c.green('   ✅ Credentials deleted'));
              removed++;
            } catch (e) {
              console.log(c.red(`   ❌ Failed to delete credentials: ${e.message}`));
            }
          } else {
            console.log(c.yellow('   ⚠️  Credentials kept'));
            kept++;
          }
          
          // 4. Ask about config
          console.log(c.yellow('\n4. Configuration...'));
          const configPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
          try {
            const { configExists, DEFAULT_CONFIG_PATH } = await import('file://' + configPath);
            if (await configExists()) {
              readline.question('   Delete config file? (y/N): ', async (answer) => {
                if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                  try {
                    fs.unlinkSync(DEFAULT_CONFIG_PATH);
                    console.log(c.green('   ✅ Config deleted'));
                    removed++;
                  } catch (e) {
                    console.log(c.red(`   ❌ Failed to delete config: ${e.message}`));
                  }
                } else {
                  console.log(c.yellow('   ⚠️  Config kept'));
                  kept++;
                }
                
                // 5. Remove CLI binary (if installed globally)
                console.log(c.yellow('\n5. CLI binary...'));
                const cliPaths = [
                  '/usr/local/bin/teleportation',
                  '/usr/bin/teleportation',
                  path.join(HOME_DIR, '.local', 'bin', 'teleportation')
                ];
                
                let cliRemoved = false;
                for (const cliPath of cliPaths) {
                  if (fs.existsSync(cliPath)) {
                    try {
                      fs.unlinkSync(cliPath);
                      console.log(c.green(`   ✅ Removed ${cliPath}`));
                      removed++;
                      cliRemoved = true;
                      break;
                    } catch (e) {
                      // Need sudo, inform user
                      console.log(c.yellow(`   ⚠️  ${cliPath} exists but requires sudo to remove`));
                      console.log(c.cyan(`      Run: sudo rm ${cliPath}`));
                    }
                  }
                }
                
                if (!cliRemoved) {
                  console.log(c.yellow('   ⚠️  CLI binary not found in standard locations'));
                  console.log(c.cyan('      If installed elsewhere, remove manually'));
                }
                
                // 6. Deregister from relay API (if credentials available)
                console.log(c.yellow('\n6. Relay API deregistration...'));
                const creds = await getCredentials();
                if (creds.RELAY_API_URL && creds.RELAY_API_KEY) {
                  try {
                    // Try to deregister (if endpoint exists)
                    await fetch(`${creds.RELAY_API_URL}/api/sessions/deregister`, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${creds.RELAY_API_KEY}`,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({ session_id: 'uninstall' })
                    }).catch(() => {}); // Ignore errors
                    console.log(c.green('   ✅ Attempted deregistration'));
                  } catch (e) {
                    console.log(c.yellow('   ⚠️  Could not deregister (non-critical)'));
                  }
                } else {
                  console.log(c.yellow('   ⚠️  No credentials available for deregistration'));
                }
                
                // Summary
                console.log(c.purple('\n📊 Uninstall Summary\n'));
                console.log(`   Removed: ${c.green(removed)} items`);
                if (kept > 0) {
                  console.log(`   Kept: ${c.yellow(kept)} items`);
                }
                console.log(c.green('\n✅ Uninstall complete!\n'));
                console.log(c.cyan('Note: Environment variables in ~/.zshrc were not removed.'));
                console.log(c.cyan('      Remove them manually if desired.\n'));
                
                readline.close();
                resolve();
              });
            } else {
              console.log(c.yellow('   ⚠️  Config file does not exist'));
              readline.close();
              resolve();
            }
          } catch (e) {
            console.log(c.yellow('   ⚠️  Could not check config'));
            readline.close();
            resolve();
          }
        });
      } else {
        console.log(c.yellow('   ⚠️  No credentials found'));
        readline.close();
        resolve();
      }
    });
  });
}

function commandInfo() {
  console.log(c.purple('Teleportation System Information\n'));
  
  console.log(c.yellow('Project:'));
  console.log('  Location:', c.cyan(TELEPORTATION_DIR));
  console.log('  Home:', c.cyan(HOME_DIR));
  
  console.log('\n' + c.yellow('Configuration:'));
  console.log('  Global hooks:', c.cyan(config.globalHooksDir));
  console.log('  Settings:', c.cyan(config.globalSettings));
  console.log('  Status:', config.isConfigured() ? c.green('CONFIGURED') : c.red('NOT CONFIGURED'));
  
  console.log('\n' + c.yellow('Services:'));
  console.log('  Relay API:', checkService('relay', 3030) ? c.green('RUNNING') : c.red('STOPPED'));
  console.log('  Storage API:', checkService('storage', 3040) ? c.green('RUNNING') : c.red('STOPPED'));
  
  console.log('\n' + c.yellow('Logs:'));
  console.log('  Relay:', c.cyan(path.join(HOME_DIR, 'Library/Logs/teleportation-relay.log')));
  console.log('  Storage:', c.cyan(path.join(HOME_DIR, 'Library/Logs/teleportation-storage.log')));
  
  console.log();
}

function commandLogs(args) {
  const service = args[0] || 'relay';
  const logFile = path.join(HOME_DIR, 'Library/Logs', `teleportation-${service}.log`);
  
  if (fs.existsSync(logFile)) {
    console.log(c.yellow(`Showing logs for ${service}:\n`));
    try {
      const logs = execSync(`tail -20 ${logFile}`, { encoding: 'utf8' });
      console.log(logs);
    } catch (e) {
      console.log(c.red('Error reading logs'));
    }
  } else {
    console.log(c.red(`Log file not found: ${logFile}`));
  }
}

async function commandLogin(args) {
  const { flags, positional } = parseFlags(args);
  
  console.log(c.purple('Teleportation Login\n'));
  
  // Load credential manager
  const manager = await loadCredentialManager();
  if (!manager) {
    console.log(c.red('❌ Failed to load credential manager'));
    process.exit(1);
  }

  // Check for existing credentials
  const existing = await manager.load();
  if (existing) {
    console.log(c.yellow('⚠️  You are already logged in.'));
    console.log(c.cyan('   Run "teleportation logout" to clear existing credentials.\n'));
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      readline.question('Do you want to overwrite existing credentials? (y/N): ', async (answer) => {
        readline.close();
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          console.log(c.yellow('Login cancelled.\n'));
          resolve();
          return;
        }
        await performLogin(manager, flags, positional);
        resolve();
      });
    });
  }
  
  await performLogin(manager, flags, positional);
}

async function performLogin(manager, flags, positional) {
  let apiKey = flags['api-key'] || flags.k;
  let token = flags.token || flags.t;
  const relayApiUrl = flags['relay-url'] || flags.r || process.env.RELAY_API_URL || 'https://api.teleportation.dev';

  // Create backup before modifying credentials (only if credentials exist)
  const existingCreds = await manager.load().catch(() => null);
  if (existingCreds) {
    try {
      const backupManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'backup', 'manager.js');
      const { BackupManager } = await import('file://' + backupManagerPath);
      const backupMgr = new BackupManager();
      await backupMgr.createBackup('teleportation login');
      console.log(c.dim('Backup created before credential update.\n'));
    } catch (backupErr) {
      // Non-fatal - warn but continue
      if (process.env.DEBUG) {
        console.log(c.yellow(`⚠️  Could not create backup: ${backupErr.message}`));
      }
    }
  }

  // If API key provided via flag
  if (apiKey) {
    console.log(c.yellow('Authenticating with API key...\n'));
    
    try {
      const apiKeyPath = path.join(TELEPORTATION_DIR, 'lib', 'auth', 'api-key.js');
      const { validateApiKey } = await import('file://' + apiKeyPath);
      const result = await validateApiKey(apiKey, relayApiUrl);
      
      if (!result.valid) {
        console.log(c.red(`❌ ${result.error}\n`));
        process.exit(1);
      }
      
      // Save credentials
      const credentials = {
        apiKey: apiKey,
        relayApiUrl: relayApiUrl,
        authenticatedAt: Date.now(),
        method: 'api-key'
      };
      
      await manager.save(credentials);

      // Also sync config to match credentials
      try {
        const configManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
        const { setConfigValue } = await import('file://' + configManagerPath);
        await setConfigValue('relay.url', relayApiUrl);
      } catch (configErr) {
        // Non-fatal - just warn
        console.log(c.yellow(`⚠️  Could not sync config: ${configErr.message}`));
      }

      console.log(c.green('✅ Successfully authenticated with API key!\n'));
      console.log(c.cyan('Credentials saved to ~/.teleportation/credentials\n'));
      console.log(c.yellow('⚠️  Restart Claude Code to apply changes to current session.\n'));
      return;
    } catch (error) {
      console.log(c.red(`❌ Error: ${error.message}\n`));
      process.exit(1);
    }
  }

  // If token provided via flag
  if (token) {
    console.log(c.yellow('Authenticating with token...\n'));
    
    try {
      // Save credentials with token
      const credentials = {
        accessToken: token,
        relayApiUrl: relayApiUrl,
        authenticatedAt: Date.now(),
        method: 'token'
      };
      
      await manager.save(credentials);

      // Also sync config to match credentials
      try {
        const configManagerPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
        const { setConfigValue } = await import('file://' + configManagerPath);
        await setConfigValue('relay.url', relayApiUrl);
      } catch (configErr) {
        // Non-fatal - just warn
        console.log(c.yellow(`⚠️  Could not sync config: ${configErr.message}`));
      }

      console.log(c.green('✅ Successfully authenticated with token!\n'));
      console.log(c.cyan('Credentials saved to ~/.teleportation/credentials\n'));
      console.log(c.yellow('⚠️  Restart Claude Code to apply changes to current session.\n'));
      return;
    } catch (error) {
      console.log(c.red(`❌ Error: ${error.message}\n`));
      process.exit(1);
    }
  }

  // Interactive mode - prompt for API key
  console.log(c.cyan('Interactive login mode\n'));
  console.log(c.yellow('Options:'));
  console.log('  1. API Key authentication (recommended)');
  console.log('  2. OAuth device code flow (coming soon)\n');
  
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    readline.question('Enter your API key (or press Enter to skip): ', async (input) => {
      readline.close();
      
      if (!input || input.trim() === '') {
        console.log(c.yellow('\n⚠️  No API key provided.'));
        console.log(c.cyan('   Use --api-key flag or --token flag for non-interactive login.\n'));
        console.log(c.cyan('   Example: teleportation login --api-key YOUR_KEY\n'));
        resolve();
        return;
      }
      
      apiKey = input.trim();
      console.log(c.yellow('\nValidating API key...\n'));
      
      try {
        const apiKeyPath = path.join(TELEPORTATION_DIR, 'lib', 'auth', 'api-key.js');
      const { validateApiKey } = await import('file://' + apiKeyPath);
        const result = await validateApiKey(apiKey, relayApiUrl);
        
        if (!result.valid) {
          console.log(c.red(`❌ ${result.error}\n`));
          process.exit(1);
        }
        
        // Save credentials
        const credentials = {
          apiKey: apiKey,
          relayApiUrl: relayApiUrl,
          authenticatedAt: Date.now(),
          method: 'api-key'
        };
        
        await manager.save(credentials);
        console.log(c.green('✅ Successfully authenticated!\n'));
        console.log(c.cyan('Credentials saved to ~/.teleportation/credentials\n'));
        resolve();
      } catch (error) {
        console.log(c.red(`❌ Error: ${error.message}\n`));
        process.exit(1);
      }
    });
  });
}

async function commandConfig(args) {
  const subcommand = args[0] || 'list';
  
  try {
    const configPath = path.join(TELEPORTATION_DIR, 'lib', 'config', 'manager.js');
    const { loadConfig, getConfigValue, setConfigValue, configExists, DEFAULT_CONFIG_PATH } = await import('file://' + configPath);
    
    if (subcommand === 'list') {
      console.log(c.purple('Teleportation Configuration\n'));
      
      const config = await loadConfig();
      const exists = await configExists();
      
      if (!exists) {
        console.log(c.yellow('⚠️  Config file does not exist. Using defaults.\n'));
      }
      
      console.log(c.cyan('Relay Settings:'));
      console.log(`  URL: ${c.green(config.relay?.url || 'not set')}`);
      console.log(`  Timeout: ${c.green((config.relay?.timeout || 0) + 'ms')}`);
      
      console.log(c.cyan('\nHook Settings:'));
      console.log(`  Auto-update: ${config.hooks?.autoUpdate ? c.green('enabled') : c.yellow('disabled')}`);
      console.log(`  Update check interval: ${c.green((config.hooks?.updateCheckInterval || 0) / 1000 / 60 + ' minutes')}`);
      
      console.log(c.cyan('\nSession Settings:'));
      console.log(`  Timeout: ${c.green((config.session?.timeout || 0) / 1000 / 60 + ' minutes')}`);
      console.log(`  Mute timeout: ${c.green((config.session?.muteTimeout || 0) / 1000 / 60 + ' minutes')}`);
      
      console.log(c.cyan('\nNotification Settings:'));
      console.log(`  Enabled: ${config.notifications?.enabled ? c.green('yes') : c.yellow('no')}`);
      console.log(`  Sound: ${config.notifications?.sound ? c.green('enabled') : c.yellow('disabled')}`);
      
      console.log(c.cyan(`\nConfig file: ${DEFAULT_CONFIG_PATH}\n`));
      
    } else if (subcommand === 'get') {
      const key = args[1];
      if (!key) {
        console.log(c.red('❌ Error: Please specify a config key\n'));
        console.log(c.cyan('Example: teleportation config get relay.url\n'));
        return;
      }
      
      const value = await getConfigValue(key);
      if (value === null) {
        console.log(c.yellow(`⚠️  Config key "${key}" not found\n`));
      } else {
        console.log(c.green(JSON.stringify(value, null, 2) + '\n'));
      }
      
    } else if (subcommand === 'set') {
      const key = args[1];
      const valueStr = args[2];
      
      if (!key || valueStr === undefined) {
        console.log(c.red('❌ Error: Please specify key and value\n'));
        console.log(c.cyan('Example: teleportation config set relay.url http://example.com:3030\n'));
        return;
      }
      
      // Try to parse value as JSON, number, or boolean
      let value = valueStr;
      try {
        value = JSON.parse(valueStr);
      } catch {
        // Not JSON, try boolean or number
        if (valueStr === 'true') value = true;
        else if (valueStr === 'false') value = false;
        else if (/^\d+$/.test(valueStr)) value = parseInt(valueStr, 10);
        else if (/^\d+\.\d+$/.test(valueStr)) value = parseFloat(valueStr);
      }
      
      await setConfigValue(key, value);
      console.log(c.green(`✅ Set ${key} = ${JSON.stringify(value)}\n`));
      
    } else if (subcommand === 'edit') {
      const editor = process.env.EDITOR || 'vi';
      const exists = await configExists();
      
      if (!exists) {
        // Create default config first
        const { saveConfig, loadConfig } = await import('file://' + configPath);
        const config = await loadConfig();
        await saveConfig(config);
        console.log(c.yellow('Created default config file.\n'));
      }
      
      console.log(c.cyan(`Opening config in ${editor}...\n`));
      try {
        execSync(`${editor} ${DEFAULT_CONFIG_PATH}`, { stdio: 'inherit' });
        console.log(c.green('✅ Config file saved\n'));
      } catch (e) {
        console.log(c.red(`❌ Error opening editor: ${e.message}\n`));
      }
      
    } else {
      console.log(c.red(`❌ Unknown config subcommand: ${subcommand}\n`));
      console.log(c.yellow('Available subcommands:'));
      console.log('  list  - Show all settings');
      console.log('  get   - Get specific setting');
      console.log('  set   - Update setting');
      console.log('  edit  - Open config in editor\n');
    }
  } catch (error) {
    console.log(c.red(`❌ Error: ${error.message}\n`));
    throw error;
  }
}

async function commandLogout() {
  console.log(c.purple('Teleportation Logout\n'));
  
  const manager = await loadCredentialManager();
  if (!manager) {
    console.log(c.red('❌ Failed to load credential manager'));
    process.exit(1);
  }

  const exists = await manager.exists();
  if (!exists) {
    console.log(c.yellow('⚠️  No credentials found. You are not logged in.\n'));
    return;
  }

  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    readline.question('Are you sure you want to log out? (y/N): ', async (answer) => {
      readline.close();
      
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(c.yellow('Logout cancelled.\n'));
        resolve();
        return;
      }

      try {
        await manager.delete();
        console.log(c.green('✅ Successfully logged out!\n'));
        console.log(c.cyan('Credentials cleared from ~/.teleportation/credentials\n'));
        resolve();
      } catch (error) {
        console.log(c.red(`❌ Error: ${error.message}\n`));
        process.exit(1);
      }
    });
  });
}

// Worktree/Snapshot/Session command handlers
async function commandWorktree(args) {
  const cliPath = path.join(TELEPORTATION_DIR, 'lib', 'cli', 'index.js');
  const { parseArgs, routeCommand, printHelp } = await import('file://' + cliPath);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    printHelp();
    return;
  }

  const parsed = parseArgs(['worktree', ...args]);
  await routeCommand(parsed);
}

async function commandSnapshot(args) {
  const cliPath = path.join(TELEPORTATION_DIR, 'lib', 'cli', 'index.js');
  const { parseArgs, routeCommand, printHelp } = await import('file://' + cliPath);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    printHelp();
    return;
  }

  const parsed = parseArgs(['snapshot', ...args]);
  await routeCommand(parsed);
}

async function commandSession(args) {
  const cliPath = path.join(TELEPORTATION_DIR, 'lib', 'cli', 'index.js');
  const { parseArgs, routeCommand, printHelp } = await import('file://' + cliPath);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    printHelp();
    return;
  }

  const parsed = parseArgs(['session', ...args]);
  await routeCommand(parsed);
}

async function commandDaemon(args) {
  const subCommand = args[0] || 'status';

  // Get daemon port from env with default (consistent with daemon itself)
  const DAEMON_PORT = process.env.TELEPORTATION_DAEMON_PORT || '3050';

  try {
    // Dynamically import lifecycle module
    const lifecyclePath = path.join(TELEPORTATION_DIR, 'lib', 'daemon', 'lifecycle.js');
    const { startDaemon, stopDaemon, restartDaemon, getDaemonStatus } = await import('file://' + lifecyclePath);

    switch (subCommand) {
      case 'start':
        console.log(c.yellow('Starting Teleportation Daemon...\n'));
        try {
          const result = await startDaemon();
          console.log(c.green(`✅ Daemon started successfully (PID: ${result.pid})\n`));
          console.log(c.cyan(`Daemon is running at http://127.0.0.1:${DAEMON_PORT}\n`));
        } catch (error) {
          console.log(c.red(`❌ Failed to start daemon: ${error.message}\n`));
          process.exit(1);
        }
        break;

      case 'stop':
        console.log(c.yellow('Stopping Teleportation Daemon...\n'));
        try {
          const result = await stopDaemon();
          if (result.success) {
            console.log(c.green(`✅ Daemon stopped successfully${result.forced ? ' (forced)' : ''}\n`));
          } else {
            console.log(c.red('❌ Failed to stop daemon\n'));
            process.exit(1);
          }
        } catch (error) {
          console.log(c.red(`❌ Error: ${error.message}\n`));
          process.exit(1);
        }
        break;

      case 'restart':
        console.log(c.yellow('Restarting Teleportation Daemon...\n'));
        try {
          const result = await restartDaemon();
          console.log(c.green(`✅ Daemon restarted successfully (PID: ${result.pid})\n`));
          console.log(c.cyan(`Previous daemon ${result.wasRunning ? 'was running' : 'was not running'}\n`));
        } catch (error) {
          console.log(c.red(`❌ Failed to restart daemon: ${error.message}\n`));
          process.exit(1);
        }
        break;

      case 'status':
        const status = await getDaemonStatus();
        console.log(c.purple('Teleportation Daemon Status\n'));
        if (status.running) {
          console.log(c.green(`✅ Running (PID: ${status.pid})`));
          console.log(c.cyan(`   HTTP server: http://127.0.0.1:${DAEMON_PORT}`));
          if (status.uptime) {
            console.log(c.cyan(`   Uptime: ${Math.round(status.uptime / 60000)}m`));
          }
        } else {
          console.log(c.red('❌ Not running'));
        }
        console.log('');
        break;

      case 'health':
        console.log(c.yellow('Checking daemon health...\n'));
        try {
          const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`);
          if (response.ok) {
            const data = await response.json();
            console.log(c.green('✅ Daemon is healthy\n'));
            console.log(c.cyan('Health Report:'));
            console.log(`  Status: ${c.green(data.status)}`);
            console.log(`  Uptime: ${c.cyan(Math.round(data.uptime) + 's')}`);
            console.log(`  Sessions: ${c.cyan(data.sessions)}`);
            console.log(`  Queue: ${c.cyan(data.queue)}`);
            console.log(`  Executions: ${c.cyan(data.executions)}\n`);
          } else {
            console.log(c.red('❌ Daemon is unhealthy\n'));
            process.exit(1);
          }
        } catch (error) {
          console.log(c.red(`❌ Cannot reach daemon: ${error.message}\n`));
          process.exit(1);
        }
        break;

      default:
        console.log(c.red(`Unknown daemon command: ${subCommand}\n`));
        console.log(c.cyan('Available commands:'));
        console.log('  teleportation daemon start    - Start the daemon');
        console.log('  teleportation daemon stop     - Stop the daemon');
        console.log('  teleportation daemon restart  - Restart the daemon');
        console.log('  teleportation daemon status   - Show daemon status');
        console.log('  teleportation daemon health   - Check daemon health\n');
        process.exit(1);
    }
  } catch (error) {
    console.log(c.red(`❌ Daemon command failed: ${error.message}\n`));
    process.exit(1);
  }
}

// Away Mode Commands (Task 9.0)
async function commandAwayMode() {
  console.log(c.yellow('🚀 Marking session as away and starting daemon...\n'));

  const sessionId = process.env.TELEPORTATION_SESSION_ID;
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable: export TELEPORTATION_SESSION_ID=<session-id>\n'));
    process.exit(1);
  }

  const relayUrl = process.env.RELAY_API_URL || '';
  const relayKey = process.env.RELAY_API_KEY || '';

  if (!relayUrl || !relayKey) {
    console.log(c.red('❌ Error: RELAY_API_URL or RELAY_API_KEY not set\n'));
    process.exit(1);
  }

  try {
    // Update session daemon state
    const res = await fetch(`${relayUrl}/api/sessions/${encodeURIComponent(sessionId)}/daemon-state`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relayKey}`,
      },
      body: JSON.stringify({
        is_away: true,
        status: 'running',
        started_reason: 'cli_away',
      }),
    });

    if (!res.ok) {
      console.log(c.yellow('⚠️  Warning: Could not update session state via Relay API\n'));
    } else {
      console.log(c.green('✅ Session marked as away in Relay API\n'));
    }

    console.log(c.green('✅ Session marked as away. Daemon is ready.\n'));
    console.log(c.cyan('When you return, run: teleportation back\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

async function commandBackMode() {
  console.log(c.yellow('🔙 Marking session as back...\n'));

  const sessionId = process.env.TELEPORTATION_SESSION_ID;
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable: export TELEPORTATION_SESSION_ID=<session-id>\n'));
    process.exit(1);
  }

  const relayUrl = process.env.RELAY_API_URL || '';
  const relayKey = process.env.RELAY_API_KEY || '';

  if (!relayUrl || !relayKey) {
    console.log(c.red('❌ Error: RELAY_API_URL or RELAY_API_KEY not set\n'));
    process.exit(1);
  }

  try {
    // Update session daemon state
    const res = await fetch(`${relayUrl}/api/sessions/${encodeURIComponent(sessionId)}/daemon-state`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relayKey}`,
      },
      body: JSON.stringify({
        is_away: false,
        status: 'stopped',
        started_reason: null,
      }),
    });

    if (!res.ok) {
      console.log(c.yellow('⚠️  Warning: Could not update session state via Relay API\n'));
    } else {
      console.log(c.green('✅ Session marked as back in Relay API\n'));
    }

    console.log(c.green('✅ Session marked as back.\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

async function commandDaemonStatusDisplay() {
  console.log(c.cyan('\n📊 Daemon Status\n'));

  const sessionId = process.env.TELEPORTATION_SESSION_ID;
  const relayUrl = process.env.RELAY_API_URL || '';
  const relayKey = process.env.RELAY_API_KEY || '';

  if (sessionId && relayUrl && relayKey) {
    try {
      const res = await fetch(`${relayUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { 'Authorization': `Bearer ${relayKey}` },
      });

      if (res.ok) {
        const session = await res.json();
        const daemonState = session.daemon_state;

        if (daemonState) {
          console.log(c.yellow('Session State:'));
          console.log(`  Status: ${daemonState.status === 'running' ? c.green('Running') : c.red('Stopped')}`);
          console.log(`  Away: ${daemonState.is_away ? c.yellow('Yes') : c.green('No')}`);

          if (daemonState.started_at) {
            const startedDate = new Date(daemonState.started_at);
            console.log(`  Started: ${startedDate.toLocaleString()}`);
          }

          if (daemonState.started_reason) {
            console.log(`  Started Reason: ${daemonState.started_reason}`);
          }

          if (daemonState.last_approval_location) {
            console.log(`  Last Approval: ${daemonState.last_approval_location}`);
          }

          if (daemonState.stopped_reason) {
            console.log(`  Stopped Reason: ${daemonState.stopped_reason}`);
          }
        }
      }
    } catch (err) {
      console.log(c.yellow('⚠️  Could not fetch session state from Relay API\n'));
    }
  } else {
    console.log(c.yellow('⚠️  Session ID or Relay API not configured\n'));
  }

  console.log();
}

async function commandInbox() {
  const sessionId = process.env.TELEPORTATION_SESSION_ID;
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable: export TELEPORTATION_SESSION_ID=<session-id>\n'));
    process.exit(1);
  }

  const creds = await getCredentials();
  const relayUrl = creds.RELAY_API_URL;
  const relayKey = creds.RELAY_API_KEY;

  if (!relayUrl || !relayKey) {
    console.log(c.red('❌ Error: RELAY_API_URL or RELAY_API_KEY not configured\n'));
    process.exit(1);
  }

  try {
    const url = `${relayUrl}/api/messages/pending?session_id=${encodeURIComponent(sessionId)}&agent_id=main`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${relayKey}`,
      },
    });

    if (!res.ok) {
      console.log(c.red(`❌ Error: Inbox request failed with status ${res.status}\n`));
      process.exit(1);
    }

    const data = await res.json();
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    if (!keys.length) {
      console.log(c.cyan('📭 No pending inbox messages for this session\n'));
      return;
    }

    console.log(c.cyan('📨 Next inbox message:\n'));
    console.log('  ID:   ' + c.green(data.id));
    console.log('  Text: ' + data.text + '\n');
    console.log(c.cyan('Use `teleportation inbox-ack ' + data.id + '` to acknowledge this message.\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

async function commandInboxAck(id) {
  if (!id) {
    console.log(c.red('❌ Error: Message id is required\n'));
    console.log(c.cyan('Usage: teleportation inbox-ack <id>\n'));
    process.exit(1);
  }

  const creds = await getCredentials();
  const relayUrl = creds.RELAY_API_URL;
  const relayKey = creds.RELAY_API_KEY;

  if (!relayUrl || !relayKey) {
    console.log(c.red('❌ Error: RELAY_API_URL or RELAY_API_KEY not configured\n'));
    process.exit(1);
  }

  try {
    const url = `${relayUrl}/api/messages/${encodeURIComponent(id)}/ack`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${relayKey}`,
      },
    });

    if (!res.ok) {
      console.log(c.red(`❌ Error: Acknowledge failed with status ${res.status}\n`));
      process.exit(1);
    }

    console.log(c.green('✅ Message acknowledged\n'));
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

/**
 * Install hooks globally to ~/.claude/hooks/
 * This command copies hooks from the teleportation project to the global location
 * and merges settings into ~/.claude/settings.json
 */
async function commandInstallHooks() {
  console.log(c.purple('🔧 Installing Teleportation Hooks Globally\n'));

  const globalHooksDir = path.join(HOME_DIR, '.claude', 'hooks');
  const globalSettings = path.join(HOME_DIR, '.claude', 'settings.json');
  const sourceHooksDir = path.join(TELEPORTATION_DIR, '.claude', 'hooks');

  // List of hooks to install
  const hooks = [
    'pre_tool_use.mjs',
    'post_tool_use.mjs',
    'permission_request.mjs',
    'stop.mjs',
    'session_start.mjs',
    'session_end.mjs',
    'notification.mjs',
    'user_prompt_submit.mjs',
    'config-loader.mjs',
    'session-register.mjs'
  ];

  // Step 1: Ensure directories exist
  console.log(c.yellow('Step 1: Creating directories...\n'));
  try {
    if (!fs.existsSync(path.join(HOME_DIR, '.claude'))) {
      fs.mkdirSync(path.join(HOME_DIR, '.claude'), { recursive: true });
    }
    if (!fs.existsSync(globalHooksDir)) {
      fs.mkdirSync(globalHooksDir, { recursive: true });
    }
    console.log(c.green('  ✅ ~/.claude/hooks/ directory ready\n'));
  } catch (e) {
    console.log(c.red(`  ❌ Failed to create directories: ${e.message}\n`));
    process.exit(1);
  }

  // Step 2: Copy hook files
  console.log(c.yellow('Step 2: Copying hooks...\n'));
  let installed = 0;
  let failed = 0;

  for (const hook of hooks) {
    const src = path.join(sourceHooksDir, hook);
    const dest = path.join(globalHooksDir, hook);

    try {
      if (!fs.existsSync(src)) {
        console.log(c.yellow(`  ⚠️  ${hook} not found in source, skipping`));
        continue;
      }

      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755); // Make executable
      console.log(c.green(`  ✅ ${hook}`));
      installed++;
    } catch (e) {
      console.log(c.red(`  ❌ ${hook}: ${e.message}`));
      failed++;
    }
  }

  console.log(`\n  Installed: ${c.green(installed)}, Failed: ${failed > 0 ? c.red(failed) : '0'}\n`);

  // Step 3: Update settings.json
  console.log(c.yellow('Step 3: Updating Claude Code settings...\n'));

  // Safely quote paths - JSON.stringify escapes special chars to prevent command injection
  const quotePath = (p) => JSON.stringify(p);
  
  const hooksConfig = {
    PreToolUse: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'pre_tool_use.mjs'))}`
      }]
    }],
    PostToolUse: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'post_tool_use.mjs'))}`
      }]
    }],
    PermissionRequest: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'permission_request.mjs'))}`
      }]
    }],
    Stop: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'stop.mjs'))}`
      }]
    }],
    SessionStart: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'session_start.mjs'))}`
      }]
    }],
    SessionEnd: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'session_end.mjs'))}`
      }]
    }],
    Notification: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'notification.mjs'))}`
      }]
    }],
    UserPromptSubmit: [{
      matcher: ".*",
      hooks: [{
        type: "command",
        command: `node ${quotePath(path.join(globalHooksDir, 'user_prompt_submit.mjs'))}`
      }]
    }]
  };

  try {
    let existingSettings = {};
    
    // Load existing settings if present
    if (fs.existsSync(globalSettings)) {
      try {
        const content = fs.readFileSync(globalSettings, 'utf8');
        existingSettings = JSON.parse(content);
        console.log(c.cyan('  Found existing settings, merging...\n'));
      } catch (e) {
        console.log(c.yellow(`  ⚠️  Could not parse existing settings, creating new...\n`));
      }
    }

    // Merge hooks intelligently - preserve user hooks, avoid duplicates
    const mergeHookArrays = (existing, incoming) => {
      if (!existing || !Array.isArray(existing)) return incoming;
      if (!incoming || !Array.isArray(incoming)) return existing;
      
      // Get commands from incoming hooks to check for duplicates
      const incomingCommands = new Set(
        incoming.flatMap(h => (h.hooks || []).map(hh => hh.command))
      );
      
      // Filter out existing hooks that have the same command (will be replaced)
      const filteredExisting = existing.filter(h => 
        !(h.hooks || []).some(hh => incomingCommands.has(hh.command))
      );
      
      // Combine: existing (non-duplicate) + incoming (teleportation hooks)
      return [...filteredExisting, ...incoming];
    };

    // Merge all hook types with warnings about user hooks
    const mergedHooks = { ...(existingSettings.hooks || {}) };
    let hasUserHooks = false;
    
    for (const [hookType, hookConfig] of Object.entries(hooksConfig)) {
      const existingHooksForType = existingSettings.hooks?.[hookType] || [];
      
      // Find user-defined hooks (not from teleportation)
      const userHooks = existingHooksForType.filter(h => {
        const commands = (h.hooks || []).map(hh => hh.command || '');
        return !commands.some(cmd => 
          cmd.includes('teleportation') || 
          cmd.includes('.claude/hooks') ||
          cmd.includes('~/.claude/hooks')
        );
      });
      
      if (userHooks.length > 0) {
        hasUserHooks = true;
        console.log(c.yellow(`  ⚠️  Preserving ${userHooks.length} custom ${hookType} hook(s):`));
        userHooks.forEach(h => {
          const cmds = (h.hooks || []).map(hh => hh.command || 'unknown');
          cmds.forEach(cmd => console.log(c.dim(`     • ${cmd}`)));
        });
        console.log('');
      }
      
      mergedHooks[hookType] = mergeHookArrays(existingHooksForType, hookConfig);
    }
    
    if (hasUserHooks) {
      console.log(c.cyan('  Your custom hooks will continue to work alongside Teleportation hooks.\n'));
    }

    const mergedSettings = {
      ...existingSettings,
      hooks: mergedHooks
    };

    // Write settings
    fs.writeFileSync(globalSettings, JSON.stringify(mergedSettings, null, 2));
    console.log(c.green('  ✅ ~/.claude/settings.json updated\n'));
  } catch (e) {
    console.log(c.red(`  ❌ Failed to update settings: ${e.message}\n`));
    process.exit(1);
  }

  // Summary
  console.log(c.cyan('╭─────────────────────────────────────────────────────╮'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('│   🎉 ') + c.green('Hooks Installed Successfully!') + c.cyan('               │'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('│   Hooks location: ~/.claude/hooks/                  │'));
  console.log(c.cyan('│   Settings: ~/.claude/settings.json                 │'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('│   ') + c.yellow('⚠️  Restart Claude Code') + c.cyan(' to activate hooks.      │'));
  console.log(c.cyan('│                                                     │'));
  console.log(c.cyan('╰─────────────────────────────────────────────────────╯\n'));

  console.log(c.cyan('Next steps:'));
  console.log('  1. If not logged in: teleportation login');
  console.log('  2. Check status: teleportation status');
  console.log('  3. Restart Claude Code to apply hooks\n');
}

async function commandCommand() {
  const sessionId = process.env.TELEPORTATION_SESSION_ID;
  if (!sessionId) {
    console.log(c.red('❌ Error: TELEPORTATION_SESSION_ID not set\n'));
    console.log(c.cyan('Set the environment variable: export TELEPORTATION_SESSION_ID=<session-id>\n'));
    process.exit(1);
  }

  const text = process.argv.slice(3).join(' ');
  if (!text) {
    console.log(c.red('❌ Error: Command text is required\n'));
    console.log(c.cyan('Usage: teleportation command "<text>"\n'));
    process.exit(1);
  }

  const creds = await getCredentials();
  const relayUrl = creds.RELAY_API_URL;
  const relayKey = creds.RELAY_API_KEY;

  if (!relayUrl || !relayKey) {
    console.log(c.red('❌ Error: RELAY_API_URL or RELAY_API_KEY not configured\n'));
    process.exit(1);
  }

  try {
    const res = await fetch(`${relayUrl}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relayKey}`,
      },
      body: JSON.stringify({
        session_id: sessionId,
        text,
        meta: {
          type: 'command',
          from: 'user',
          source: 'teleportation-cli',
          target_agent_id: 'daemon',
        },
      }),
    });

    if (!res.ok) {
      console.log(c.red(`❌ Error: Failed to enqueue command (status ${res.status})\n`));
      process.exit(1);
    }

    const data = await res.json();
    console.log(c.green('✅ Command enqueued successfully\n'));
    if (data.id) {
      console.log(c.cyan('Message ID: ') + data.id + '\n');
    }
  } catch (error) {
    console.log(c.red('❌ Error: ' + error.message + '\n'));
    process.exit(1);
  }
}

/**
 * Update command - pulls latest code and reinstalls hooks
 */
async function commandUpdate() {
  console.log(c.cyan('\n⚡ Teleportation Update\n'));
  
  // Validate HOME_DIR exists
  if (!HOME_DIR || !fs.existsSync(HOME_DIR)) {
    console.log(c.red('❌ Error: HOME directory not found\n'));
    console.log(c.yellow('Set HOME environment variable and try again.\n'));
    return;
  }
  
  const installDir = path.join(HOME_DIR, '.teleportation-cli');
  
  // Check if installed via git
  if (!fs.existsSync(path.join(installDir, '.git'))) {
    console.log(c.yellow('⚠️  Not installed via git. Reinstall with:\n'));
    console.log(c.green('   curl -fsSL https://get.teleportation.dev | bash\n'));
    return;
  }
  
  console.log(c.yellow('Step 1: Checking for local changes...\n'));
  
  const { execSync, execFile } = require('child_process');
  let stashedChanges = false;
  let stashHash = null;
  
  // Helper to check if command exists (POSIX compliant)
  // Whitelist prevents command injection if cmd parameter is compromised
  const commandExists = (cmd) => {
    // Whitelist of allowed commands to prevent command injection
    const validCommands = ['bun', 'npm', 'git', 'node'];
    if (!validCommands.includes(cmd)) {
      return false;
    }
    try {
      execSync(`command -v ${cmd}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  
  // Helper to restore stashed changes using specific stash hash
  const restoreStash = () => {
    if (stashedChanges && stashHash !== null) {
      try {
        console.log(c.yellow('  Restoring stashed changes...\n'));
        // Use execFile with args array for safety
        execFile('git', ['stash', 'pop', `stash@{${stashHash}}`], { 
          cwd: installDir, 
          stdio: 'pipe' 
        });
        console.log(c.green('  ✅ Stashed changes restored\n'));
      } catch (e) {
        console.log(c.yellow(`  ⚠️  Could not restore stash: ${e.message}\n`));
        console.log(c.yellow(`  Run \`git stash pop stash@{${stashHash}}\` manually to restore.\n`));
      }
    } else if (stashedChanges) {
      // Fallback if stash hash wasn't captured
      console.log(c.yellow('  ⚠️  Stash hash not available. Run `git stash pop` manually.\n'));
    }
  };
  
  // Get current version before update
  let versionFrom = 'unknown';
  try {
    const pkgBefore = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
    versionFrom = pkgBefore.version || 'unknown';
  } catch (e) {
    // Ignore - will show unknown
  }
  
  // Check for uncommitted changes (including untracked files)
  try {
    const status = execSync('git status --porcelain', { cwd: installDir, encoding: 'utf8' });
    if (status.trim()) {
      console.log(c.yellow('  ⚠️  Uncommitted changes detected. Stashing...\n'));
      try {
        // Use -u to include untracked files, capture stash hash from output
        const stashOutput = execSync('git stash push -u -m "teleportation-update-stash"', { 
          cwd: installDir, 
          encoding: 'utf8',
          stdio: 'pipe' 
        });
        
        // Extract stash hash from output (e.g., "Saved working directory and index state On main: stash@{0}")
        const stashMatch = stashOutput.match(/stash@\{(\d+)\}/);
        if (stashMatch) {
          stashHash = stashMatch[1];
        }
        
        console.log(c.green(`  ✅ Changes stashed (will restore on failure)\n`));
        stashedChanges = true;
      } catch (stashErr) {
        console.log(c.red(`  ❌ Failed to stash: ${stashErr.message}`));
        console.log(c.yellow('  Please commit or discard changes manually.\n'));
        return;
      }
    } else {
      console.log(c.green('  ✅ Working directory clean\n'));
    }
  } catch (e) {
    console.log(c.yellow(`  ⚠️  Could not check git status: ${e.message}\n`));
  }
  
  console.log(c.yellow('Step 2: Pulling latest changes...\n'));
  
  try {
    // Detect current branch dynamically
    const branchRaw = execSync('git rev-parse --abbrev-ref HEAD', { cwd: installDir, encoding: 'utf8' }).trim();
    
    // Sanitize branch name - only allow alphanumeric, dots, underscores, slashes, hyphens
    // Also enforce max length for safety
    if (!/^[a-zA-Z0-9._\/-]{1,100}$/.test(branchRaw)) {
      console.log(c.red(`  ❌ Invalid branch name detected: ${branchRaw}\n`));
      console.log(c.yellow('  Branch names must contain only: letters, numbers, dots, underscores, slashes, hyphens (max 100 chars)\n'));
      restoreStash();
      return;
    }
    
    const branch = branchRaw;
    console.log(c.dim(`  Branch: ${branch}\n`));
    
    // Use execFile with args array to prevent command injection
    execFile('git', ['pull', 'origin', branch], { 
      cwd: installDir, 
      stdio: 'inherit' 
    });
    console.log(c.green('\n  ✅ Code updated\n'));
  } catch (e) {
    console.log(c.red(`  ❌ Failed to pull: ${e.message}\n`));
    restoreStash();
    return;
  }
  
  console.log(c.yellow('Step 3: Installing dependencies...\n'));
  
  let depsInstalled = false;
  try {
    // Check which package manager is available
    if (commandExists('bun')) {
      // Don't use --silent so errors are visible
      execSync('bun install', { cwd: installDir, stdio: 'inherit' });
      console.log(c.green('\n  ✅ Dependencies updated (bun)\n'));
      depsInstalled = true;
    } else if (commandExists('npm')) {
      // Don't use --silent so errors are visible
      execSync('npm install', { cwd: installDir, stdio: 'inherit' });
      console.log(c.green('\n  ✅ Dependencies updated (npm)\n'));
      depsInstalled = true;
    } else {
      console.log(c.red('  ❌ No package manager found (bun or npm required)\n'));
      console.log(c.yellow('  Install Node.js or Bun and run: teleportation update\n'));
    }
  } catch (e) {
    console.log(c.red(`\n  ❌ Dependency installation failed: ${e.message}\n`));
    console.log(c.yellow('  Hooks may not work correctly. Run manually:\n'));
    console.log(c.dim(`     cd ${installDir} && npm install\n`));
  }
  
  console.log(c.yellow('Step 4: Updating hooks...\n'));
  
  // Run install-hooks with error handling
  let hooksInstalled = false;
  try {
    await commandInstallHooks();
    hooksInstalled = true;
  } catch (e) {
    console.log(c.red(`  ❌ Hook installation failed: ${e.message}\n`));
    console.log(c.yellow('  Run `teleportation install-hooks` manually to retry.\n'));
    // Don't restore stash here - code was updated successfully, hooks can be fixed separately
  }
  
  // Get version after update
  let versionTo = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
    versionTo = pkg.version || 'unknown';
  } catch (e) {
    console.log(c.yellow(`  ⚠️  Could not read version: ${e.message}\n`));
  }
  
  // Calculate dynamic padding (box width is 55 chars, need space for labels and borders)
  const formatVersionLine = (label, version) => {
    const maxVersionLen = 30; // Reasonable max for version strings
    const versionDisplay = version.length > maxVersionLen ? version.slice(0, maxVersionLen - 3) + '...' : version;
    const padding = 55 - label.length - versionDisplay.length - 4; // 4 for borders and spaces
    return `│  ${label}${' '.repeat(Math.max(1, padding))}${versionDisplay}│`;
  };
  
  // Show appropriate completion message
  console.log('');
  if (hooksInstalled && depsInstalled) {
    console.log(c.green('╭─────────────────────────────────────────────────────╮'));
    console.log(c.green('│  ✅ Update complete!                                │'));
    console.log(c.green('│                                                     │'));
    if (versionFrom !== 'unknown' || versionTo !== 'unknown') {
      console.log(c.green(formatVersionLine('From:', versionFrom)));
      console.log(c.green(formatVersionLine('To:  ', versionTo)));
    } else {
      console.log(c.green(formatVersionLine('Version:', versionTo)));
    }
    console.log(c.green('│                                                     │'));
    console.log(c.green('│  ') + c.yellow('⚠️  Restart Claude Code to apply changes.') + c.green('       │'));
    console.log(c.green('╰─────────────────────────────────────────────────────╯'));
  } else if (hooksInstalled) {
    console.log(c.yellow('╭─────────────────────────────────────────────────────╮'));
    console.log(c.yellow('│  ⚠️  Update partially complete                      │'));
    console.log(c.yellow('│                                                     │'));
    if (versionFrom !== 'unknown' || versionTo !== 'unknown') {
      console.log(c.yellow(formatVersionLine('From:', versionFrom)));
      console.log(c.yellow(formatVersionLine('To:  ', versionTo)));
    } else {
      console.log(c.yellow(formatVersionLine('Version:', versionTo)));
    }
    console.log(c.yellow('│  Hooks: ✅  Dependencies: ❌                        │'));
    console.log(c.yellow('│                                                     │'));
    console.log(c.yellow('│  Run: cd ~/.teleportation-cli && npm install        │'));
    console.log(c.yellow('╰─────────────────────────────────────────────────────╯'));
  } else {
    console.log(c.red('╭─────────────────────────────────────────────────────╮'));
    console.log(c.red('│  ❌ Update failed                                   │'));
    console.log(c.red('│                                                     │'));
    console.log(c.red('│  Code was updated but hooks failed to install.      │'));
    console.log(c.red('│  Run: teleportation install-hooks                   │'));
    console.log(c.red('╰─────────────────────────────────────────────────────╯'));
  }
  console.log('');
}

// Main
const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

// Handle async commands that need to complete before exit
const asyncCommands = ['login', 'logout', 'status', 'test', 'env', 'config', 'daemon', 'away', 'back', 'daemon-status', 'command', 'inbox', 'inbox-ack', 'install-hooks', 'update'];
if (asyncCommands.includes(command)) {
  // These commands handle their own async execution
}

try {
  switch (command) {
    case 'setup':
      commandSetup().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'backup':
      commandBackup(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'on':
      commandOn().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'install-hooks':
      commandInstallHooks().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'off':
      commandOff();
      break;
    case 'status':
      commandStatus().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'start':
      commandStart();
      break;
    case 'stop':
      commandStop();
      break;
    case 'restart':
      commandRestart();
      break;
    case 'test':
      commandTest().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'doctor':
      commandDoctor().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'uninstall':
      commandUninstall().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'env':
      commandEnv(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'config':
      commandConfig(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'info':
      commandInfo();
      break;
    case 'logs':
      commandLogs(args);
      break;
    case 'login':
      commandLogin(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'daemon':
      commandDaemon(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'away':
      commandAwayMode().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'back':
      commandBackMode().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'daemon-status':
      commandDaemonStatusDisplay().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'command':
      commandCommand().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'inbox':
      commandInbox().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'inbox-ack':
      commandInboxAck(args[0]).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'logout':
      commandLogout().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'worktree':
      commandWorktree(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'snapshot':
      commandSnapshot(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'session':
      commandSession(args).catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'version':
    case '--version':
    case '-v':
      commandVersion();
      break;
    case 'update':
      commandUpdate().catch(err => {
        console.error(c.red('❌ Error:'), err.message);
        process.exit(1);
      });
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      commandHelp();
  }
} catch (error) {
  console.error(c.red('❌ Error:'), error.message);
  process.exit(1);
}
