#!/usr/bin/env node
// Shared config loader for all hooks
// Reads from encrypted credentials (~/.teleportation/credentials), then ~/.teleportation-config.json, then env vars

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function loadConfig() {
  // Test override: allow forcing config to be loaded from environment variables only
  // This is useful for unit tests that mock the relay API.
  if (env.TELEPORTATION_CONFIG_FROM_ENV_ONLY === 'true') {
    return {
      relayApiUrl: env.RELAY_API_URL || '',
      relayApiKey: env.RELAY_API_KEY || '',
      userToken: env.DETACH_USER_TOKEN || '',
      slackWebhookUrl: env.SLACK_WEBHOOK_URL || ''
    };
  }

  // Priority 1: Try to load from encrypted credentials file
  try {
    // Try multiple possible paths for the credential manager
    const possiblePaths = [
      // If hook is still in project directory
      join(process.cwd(), 'lib', 'auth', 'credentials.js'),
      // If installed globally, try common locations
      join(homedir(), '.teleportation', 'lib', 'auth', 'credentials.js'),
      // Development path (if running from workspace)
      join(homedir(), 'dev_env', 'teleporter', 'teleportation', 'lib', 'auth', 'credentials.js'),
      // Try relative to hook location (if hooks are symlinked)
      join(__dirname, '..', '..', 'lib', 'auth', 'credentials.js')
    ];
    
    let CredentialManager = null;
    for (const credentialsPath of possiblePaths) {
      try {
        const module = await import(credentialsPath);
        CredentialManager = module.CredentialManager;
        if (CredentialManager) break;
      } catch (e) {
        // Try next path
        continue;
      }
    }
    
    if (CredentialManager) {
      const manager = new CredentialManager();
      const credentials = await manager.load();
      
      if (credentials) {
        return {
          relayApiUrl: credentials.relayApiUrl || credentials.relay_api_url || '',
          relayApiKey: credentials.relayApiKey || credentials.apiKey || credentials.relay_api_key || '',
          userToken: credentials.userToken || credentials.user_token || '',
          slackWebhookUrl: credentials.slackWebhookUrl || credentials.slack_webhook_url || ''
        };
      }
    }
  } catch (e) {
    // Credential manager not available or credentials don't exist, continue to fallback
  }
  
  // Priority 2: Try to load from legacy config file
  const configPath = join(homedir(), '.teleportation-config.json');
  
  try {
    const content = await readFile(configPath, 'utf8');
    const config = JSON.parse(content);
    return {
      relayApiUrl: config.relay_api_url || '',
      relayApiKey: config.relay_api_key || '',
      userToken: config.user_token || '',
      slackWebhookUrl: config.slack_webhook_url || ''
    };
  } catch (e) {
    // Config file doesn't exist, continue to fallback
  }
  
  // Priority 3: Fall back to environment variables
  return {
    relayApiUrl: env.RELAY_API_URL || '',
    relayApiKey: env.RELAY_API_KEY || '',
    userToken: env.DETACH_USER_TOKEN || '',
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || ''
  };
}
