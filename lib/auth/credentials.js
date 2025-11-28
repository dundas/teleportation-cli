#!/usr/bin/env node
/**
 * Credential encryption and storage management
 * Uses AES-256 encryption with system keychain for key management
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';
import { readFile, writeFile, unlink, stat, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 32; // 256 bits for AES-256
const IV_LENGTH = 16; // 128 bits for AES IV
const SALT_LENGTH = 32;
const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.teleportation', 'credentials');
const DEFAULT_KEY_PATH = join(homedir(), '.teleportation', '.key');

/**
 * Get encryption key from system keychain or fallback to file-based key
 */
async function getEncryptionKey(keyPath = DEFAULT_KEY_PATH) {
  // Try to use system keychain first (platform-specific)
  // For macOS: use security command
  // For Linux: use secret-tool or fallback to file
  // For Windows: use Credential Manager or fallback to file
  
  const platform = process.platform;
  
  if (platform === 'darwin') {
    // macOS - try to use keychain
    try {
      const { execSync } = await import('child_process');
      try {
        const key = execSync(
          'security find-generic-password -a teleportation -s encryption-key -w 2>/dev/null',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        if (key && key.length >= 32) {
          return Buffer.from(key.slice(0, 64), 'hex'); // Use first 32 bytes
        }
      } catch (e) {
        // Keychain entry doesn't exist, fall through to file-based
      }
    } catch (e) {
      // security command not available, fall through
    }
  }
  
  // Fallback: use file-based key with scrypt derivation
  try {
    const keyData = await readFile(keyPath, 'utf8');
    const parsed = JSON.parse(keyData);
    
    // If we have a stored derived key, use it directly
    if (parsed.derivedKey) {
      return Buffer.from(parsed.derivedKey, 'hex');
    }
    
    // Legacy format: derive from salt and master key
    if (parsed.salt && parsed.masterKey) {
      const key = await scryptAsync(Buffer.from(parsed.masterKey, 'hex'), Buffer.from(parsed.salt, 'hex'), KEY_LENGTH);
      // Update to new format
      await writeFile(
        keyPath,
        JSON.stringify({
          derivedKey: Buffer.from(key).toString('hex')
        }),
        { mode: 0o600 }
      );
      return Buffer.from(key);
    }
    
    throw new Error('Invalid key file format');
  } catch (e) {
    if (e.code === 'ENOENT' || e.message === 'Invalid key file format') {
      // Key file doesn't exist or is invalid, create a new one
      const masterKey = randomBytes(KEY_LENGTH);
      const salt = randomBytes(SALT_LENGTH);
      const derivedKey = await scryptAsync(masterKey, salt, KEY_LENGTH);
      
      // Ensure directory exists
      await mkdir(dirname(keyPath), { recursive: true });
      
      // Save derived key directly (32 bytes for AES-256)
      await writeFile(
        keyPath,
        JSON.stringify({
          derivedKey: Buffer.from(derivedKey).toString('hex')
        }),
        { mode: 0o600 } // Owner read/write only
      );
      
      return Buffer.from(derivedKey);
    }
    throw e;
  }
}

/**
 * Encrypt data using AES-256-GCM
 */
function encrypt(data, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    data: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
function decrypt(encryptedData, key) {
  const { data, iv, authTag } = encryptedData;
  
  if (!data || !iv || !authTag) {
    throw new Error('Invalid encrypted data structure');
  }
  
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}

/**
 * CredentialManager - handles encryption, storage, and retrieval of credentials
 */
export class CredentialManager {
  constructor(credentialsPath = DEFAULT_CREDENTIALS_PATH, keyPath = DEFAULT_KEY_PATH) {
    this.credentialsPath = credentialsPath;
    this.keyPath = keyPath;
  }

  /**
   * Save credentials to encrypted file
   */
  async save(credentials) {
    if (!credentials || typeof credentials !== 'object') {
      throw new Error('Credentials must be a non-null object');
    }

    // Ensure directory exists
    await mkdir(dirname(this.credentialsPath), { recursive: true });

    // Get encryption key
    const key = await getEncryptionKey(this.keyPath);

    // Encrypt credentials
    const encrypted = encrypt(credentials, key);

    // Add metadata
    const fileData = {
      version: '1.0',
      createdAt: Date.now(),
      ...encrypted
    };

    // Write encrypted file with 600 permissions
    await writeFile(
      this.credentialsPath,
      JSON.stringify(fileData, null, 2),
      { mode: 0o600 }
    );
  }

  /**
   * Load and decrypt credentials from file
   */
  async load() {
    try {
      const fileContent = await readFile(this.credentialsPath, 'utf8');
      const fileData = JSON.parse(fileContent);

      if (!fileData.data || !fileData.iv || !fileData.authTag) {
        throw new Error('Invalid credential file format');
      }

      // Get encryption key
      const key = await getEncryptionKey(this.keyPath);

      // Decrypt credentials
      const credentials = decrypt(
        {
          data: fileData.data,
          iv: fileData.iv,
          authTag: fileData.authTag
        },
        key
      );

      return credentials;
    } catch (e) {
      if (e.code === 'ENOENT') {
        // File doesn't exist, return null
        return null;
      }
      if (e.message === 'Invalid credential file format') {
        throw new Error('Credential file is corrupted or invalid. Please re-authenticate by running: teleportation login\n\nThe existing credential file will be replaced.');
      }
      if (e.message.includes('decrypt') || e.message.includes('Unsupported state') || e.message.includes('bad decrypt')) {
        throw new Error('Failed to decrypt credentials. This usually means:\n  - The encryption key is missing or has been changed\n  - The credential file was corrupted\n\nPlease re-authenticate by running: teleportation login');
      }
      if (e.message.includes('Invalid key file format')) {
        throw new Error('Encryption key file is corrupted. Please re-authenticate by running: teleportation login\n\nThis will regenerate the encryption key.');
      }
      // Re-throw other errors with helpful message
      throw new Error(`Failed to load credentials: ${e.message}\n\nIf this problem persists, try running: teleportation logout && teleportation login`);
    }
  }

  /**
   * Check if credentials are expired
   */
  async isExpired() {
    const credentials = await this.load();
    if (!credentials || !credentials.expiresAt) {
      return false; // No expiry set, consider valid
    }

    return Date.now() >= credentials.expiresAt;
  }

  /**
   * Check if credentials need rotation (within 7 days of expiry or expired)
   */
  async needsRotation(warningDays = 7) {
    const credentials = await this.load();
    if (!credentials || !credentials.expiresAt) {
      return false; // No expiry set, consider valid
    }

    const now = Date.now();
    const expiresAt = credentials.expiresAt;
    const warningThreshold = expiresAt - (warningDays * 24 * 60 * 60 * 1000);

    return now >= warningThreshold;
  }

  /**
   * Get days until expiry (negative if expired)
   */
  async daysUntilExpiry() {
    const credentials = await this.load();
    if (!credentials || !credentials.expiresAt) {
      return null; // No expiry set
    }

    const now = Date.now();
    const expiresAt = credentials.expiresAt;
    const diffMs = expiresAt - now;
    return Math.floor(diffMs / (24 * 60 * 60 * 1000));
  }

  /**
   * Update credentials (for token refresh or re-authentication)
   */
  async update(updates) {
    const current = await this.load();
    if (!current) {
      throw new Error('No existing credentials to update');
    }

    const updated = {
      ...current,
      ...updates,
      updatedAt: Date.now()
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Refresh access token if refresh token is available
   * This is a placeholder - actual implementation depends on OAuth provider
   */
  async refreshToken() {
    const credentials = await this.load();
    if (!credentials || !credentials.refreshToken) {
      throw new Error('No refresh token available');
    }

    // TODO: Implement actual token refresh with OAuth provider
    // For now, this is a placeholder that would be implemented in oauth-client.js
    throw new Error('Token refresh not yet implemented. Please run "teleportation login" to re-authenticate.');
  }

  /**
   * Delete credentials file
   */
  async delete() {
    try {
      await unlink(this.credentialsPath);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
      // File doesn't exist, that's fine
    }
  }

  /**
   * Verify file permissions are correct (600)
   */
  async verifyPermissions() {
    try {
      const stats = await stat(this.credentialsPath);
      const mode = stats.mode & parseInt('777', 8);
      return mode === parseInt('600', 8);
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if credentials exist
   */
  async exists() {
    try {
      await stat(this.credentialsPath);
      return true;
    } catch (e) {
      return false;
    }
  }
}

