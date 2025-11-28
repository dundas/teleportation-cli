#!/usr/bin/env node
/**
 * Configuration file management
 * Handles reading/writing ~/.teleportation/config.json
 */

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

const DEFAULT_CONFIG_PATH = join(homedir(), '.teleportation', 'config.json');

// Default configuration
const DEFAULT_CONFIG = {
  relay: {
    url: 'http://localhost:3030',
    timeout: 30000
  },
  hooks: {
    autoUpdate: true,
    updateCheckInterval: 86400000 // 24 hours
  },
  session: {
    timeout: 3600000, // 1 hour
    muteTimeout: 300000, // 5 minutes
    heartbeat: {
      enabled: true,
      interval: 120000, // 2 minutes between heartbeats
      timeout: 300000, // 5 minutes without heartbeat = session dead
      startDelay: 5000, // Wait 5 seconds after session start before first heartbeat
      maxFailures: 3 // Stop heartbeat after 3 consecutive failures
    }
  },
  notifications: {
    enabled: true,
    sound: false
  }
};

/**
 * Validate configuration structure and values
 */
function validateConfig(config) {
  const errors = [];
  const warnings = [];

  // Validate relay URL format
  if (config.relay?.url) {
    try {
      const url = new URL(config.relay.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('Relay URL must use http:// or https:// protocol');
      }
    } catch (e) {
      errors.push(`Invalid relay URL format: ${config.relay.url}`);
    }
  }

  // Validate timeout values
  if (config.relay?.timeout !== undefined) {
    if (typeof config.relay.timeout !== 'number' || config.relay.timeout < 1000) {
      errors.push('Relay timeout must be a number >= 1000ms');
    }
    if (config.relay.timeout > 300000) {
      warnings.push('Relay timeout is very high (>5 minutes), this may cause slow responses');
    }
  }

  // Validate session timeout
  if (config.session?.timeout !== undefined) {
    if (typeof config.session.timeout !== 'number' || config.session.timeout < 60000) {
      errors.push('Session timeout must be a number >= 60000ms (1 minute)');
    }
  }

  // Validate boolean values
  const booleanFields = [
    'hooks.autoUpdate',
    'notifications.enabled',
    'notifications.sound'
  ];

  booleanFields.forEach(field => {
    const value = getNestedValue(config, field);
    if (value !== undefined && typeof value !== 'boolean') {
      errors.push(`${field} must be a boolean (true/false)`);
    }
  });

  return { errors, warnings };
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

/**
 * Auto-fix common configuration issues
 */
function autoFixConfig(config) {
  const fixed = { ...config };

  // Ensure relay URL has trailing slash removed
  if (fixed.relay?.url && fixed.relay.url.endsWith('/')) {
    fixed.relay.url = fixed.relay.url.slice(0, -1);
  }

  // Ensure timeouts are within reasonable bounds
  if (fixed.relay?.timeout) {
    fixed.relay.timeout = Math.max(1000, Math.min(300000, fixed.relay.timeout));
  }

  if (fixed.session?.timeout) {
    fixed.session.timeout = Math.max(60000, Math.min(86400000, fixed.session.timeout));
  }

  return fixed;
}

/**
 * Load configuration from JSON file with validation
 */
async function loadConfig() {
  try {
    const content = await readFile(DEFAULT_CONFIG_PATH, 'utf8');
    const config = JSON.parse(content);
    
    // Auto-fix common issues
    const fixedConfig = autoFixConfig(config);
    
    // Validate configuration
    const { errors, warnings } = validateConfig(fixedConfig);
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}\n\nPlease fix these issues or delete the config file to use defaults.`);
    }
    
    if (warnings.length > 0) {
      // Log warnings but don't fail
      console.warn('Configuration warnings:');
      warnings.forEach(w => console.warn(`  - ${w}`));
    }
    
    return fixedConfig;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Config doesn't exist, return defaults
      return DEFAULT_CONFIG;
    }
    if (e instanceof SyntaxError) {
      throw new Error(`Failed to parse config file (invalid JSON): ${e.message}\n\nPlease check the JSON syntax in ${DEFAULT_CONFIG_PATH} or delete it to use defaults.`);
    }
    throw new Error(`Failed to load config: ${e.message}`);
  }
}


/**
 * Save configuration
 */
async function saveConfig(config) {
  await mkdir(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
  
  // Merge with defaults
  const merged = deepMerge(DEFAULT_CONFIG, config);
  
  // Save as JSON for now (easier to parse)
  await writeFile(
    DEFAULT_CONFIG_PATH,
    JSON.stringify(merged, null, 2),
    { mode: 0o600 }
  );
}

/**
 * Deep merge objects
 */
function deepMerge(target, source) {
  const output = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Get a specific config value by dot-notation path
 */
async function getConfigValue(path) {
  const config = await loadConfig();
  const parts = path.split('.');
  let value = config;
  
  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return null;
    }
  }
  
  return value;
}

/**
 * Set a config value by dot-notation path
 */
async function setConfigValue(path, value) {
  // Validate path doesn't contain dangerous properties (prototype pollution protection)
  if (path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')) {
    throw new Error('Invalid config path: cannot contain __proto__, constructor, or prototype');
  }
  
  // Validate path format (only alphanumeric, dots, underscores, hyphens)
  if (!/^[a-zA-Z0-9._-]+$/.test(path)) {
    throw new Error('Invalid config path format: only alphanumeric characters, dots, underscores, and hyphens allowed');
  }
  
  const config = await loadConfig();
  const parts = path.split('.');
  const lastPart = parts.pop();
  let current = config;
  
  // Navigate/create nested objects
  for (const part of parts) {
    // Additional validation for each part
    if (part.includes('__proto__') || part.includes('constructor') || part.includes('prototype')) {
      throw new Error(`Invalid config path part: ${part}`);
    }
    
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  
  // Set the value
  current[lastPart] = value;
  
  await saveConfig(config);
}

/**
 * Check if config file exists
 */
async function configExists() {
  try {
    await stat(DEFAULT_CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate configuration without loading
 */
async function validateConfigFile() {
  try {
    const config = await loadConfig();
    const validation = validateConfig(config);
    return {
      valid: validation.errors.length === 0,
      errors: validation.errors,
      warnings: validation.warnings,
      config
    };
  } catch (error) {
    return {
      valid: false,
      errors: [error.message],
      warnings: [],
      config: null
    };
  }
}

export {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  configExists,
  validateConfigFile,
  DEFAULT_CONFIG_PATH
};

