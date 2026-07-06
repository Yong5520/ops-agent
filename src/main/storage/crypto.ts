import { app, safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

// AES-256-GCM credential encryption.
//
// Master key strategy:
//   1. Generate 32 random bytes on first launch.
//   2. Encrypt the key with Electron safeStorage (OS keychain: DPAPI on
//      Windows, Keychain on macOS, libsecret on Linux).
//   3. Persist the encrypted key blob to disk.
//
// Field encryption:
//   plaintext -> IV(12 bytes random) || ciphertext || authTag(16 bytes)
//   -> base64-encoded single string for storage in SQLite TEXT columns.

const MASTER_KEY_FILE = 'master.key';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;

let cachedMasterKey: Buffer | null = null;

function masterKeyPath(): string {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  return join(userData, MASTER_KEY_FILE);
}

function ensureMasterKey(): Buffer {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption unavailable. Cannot protect credentials.',
    );
  }

  const path = masterKeyPath();
  let key: Buffer;

  if (existsSync(path)) {
    const encryptedBlob = readFileSync(path);
    const decrypted = safeStorage.decryptString(encryptedBlob);
    key = Buffer.from(decrypted, 'base64');
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Master key has unexpected length ${key.length}`);
    }
  } else {
    key = randomBytes(KEY_LENGTH);
    const encrypted = safeStorage.encryptString(key.toString('base64'));
    writeFileSync(path, encrypted);
    logger.info('Generated new master key');
  }

  cachedMasterKey = key;
  return key;
}

export function encrypt(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === '') {
    return null;
  }
  const key = ensureMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: iv(12) || authTag(16) || ciphertext
  const blob = Buffer.concat([iv, authTag, ciphertext]);
  return blob.toString('base64');
}

export function decrypt(stored: string | null | undefined): string {
  if (!stored) {
    return '';
  }
  const key = ensureMasterKey();
  const blob = Buffer.from(stored, 'base64');
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short');
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Mask a secret for display: show only the last 4 characters.
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '****' + value.slice(-4);
}

// Test that round-trip encryption works. Called once at startup.
export function verifyCrypto(): boolean {
  try {
    const sample = 'ops-agent-crypto-self-test';
    const enc = encrypt(sample);
    const dec = decrypt(enc);
    return dec === sample;
  } catch (err) {
    logger.error('Crypto self-test failed:', err);
    return false;
  }
}
