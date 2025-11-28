import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * PID Manager
 * Manages daemon process ID file for ensuring single daemon instance
 */

const TELEPORTATION_DIR = join(homedir(), '.teleportation');
const PID_FILE = join(TELEPORTATION_DIR, 'daemon.pid');

/**
 * Check if a process with given PID is running
 */
export function isProcessRunning(pid) {
  console.log(`[pid-manager] Checking if process ${pid} is running...`);
  // Handle invalid PIDs
  if (typeof pid !== 'number' || pid <= 0) {
    return false;
  }

  try {
    // Signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Read PID from file
 * @returns {Promise<number|null>} PID or null if file doesn't exist or is invalid
 */
export async function readPid() {
  console.log(`[pid-manager] Reading PID from ${PID_FILE}...`);
  try {
    const content = await fs.readFile(PID_FILE, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    if (isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Write PID to file with 600 permissions
 * @param {number} pid - Process ID to write
 */
export async function writePid(pid) {
  console.log(`[pid-manager] Writing PID ${pid} to ${PID_FILE}...`);
  // Ensure .teleportation directory exists
  await fs.mkdir(TELEPORTATION_DIR, { recursive: true, mode: 0o700 });

  // Write PID file with 600 permissions (owner read/write only)
  await fs.writeFile(PID_FILE, String(pid), { mode: 0o600 });
}

/**
 * Remove PID file
 */
export async function removePid() {
  console.log(`[pid-manager] Removing PID file ${PID_FILE}...`);
  try {
    await fs.unlink(PID_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Check if daemon is already running
 * @returns {Promise<{running: boolean, pid: number|null, stale: boolean}>}
 */
export async function checkDaemonStatus() {
  const pid = await readPid();

  if (pid === null) {
    return { running: false, pid: null, stale: false };
  }

  const running = isProcessRunning(pid);

  return {
    running,
    pid,
    stale: !running // PID file exists but process is dead
  };
}

/**
 * Clean up stale PID file (when process doesn't exist)
 * @returns {Promise<boolean>} true if stale PID was removed
 */
export async function cleanupStalePid() {
  const status = await checkDaemonStatus();

  if (status.stale) {
    await removePid();
    return true;
  }

  return false;
}

/**
 * Acquire PID lock (write PID file, ensuring no other daemon is running)
 * @param {number} pid - Process ID to write
 * @throws {Error} if another daemon is already running
 */
export async function acquirePidLock(pid) {
  console.log(`[pid-manager] Acquiring PID lock for PID ${pid}...`);
  // Clean up any stale PID files first
  await cleanupStalePid();

  // Check if daemon is running
  const status = await checkDaemonStatus();

  if (status.running) {
    throw new Error(`Daemon already running with PID ${status.pid}`);
  }

  // Write our PID
  await writePid(pid);
}

/**
 * Release PID lock (remove PID file if it matches our PID)
 * @param {number} pid - Our process ID
 */
export async function releasePidLock(pid) {
  console.log(`[pid-manager] Releasing PID lock for PID ${pid}...`);
  const currentPid = await readPid();

  // Only remove if PID file matches our process
  if (currentPid === pid) {
    await removePid();
  }
}

export default {
  isProcessRunning,
  readPid,
  writePid,
  removePid,
  checkDaemonStatus,
  cleanupStalePid,
  acquirePidLock,
  releasePidLock,
  PID_FILE
};
