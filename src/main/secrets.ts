import fs from 'node:fs';
import path from 'node:path';
import type { SecretKey } from '../shared/types.js';

/**
 * Seif local pentru tokenuri și chei.
 * Pe Windows, Electron `safeStorage` folosește DPAPI (aceeași protecție ca Windows Credential Manager):
 * datele pot fi decriptate doar de același utilizator Windows pe același calculator.
 * Am ales safeStorage în loc de `keytar` (arhivat, modul nativ greu de cross-compilat).
 */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export class SecretStore {
  private file: string;
  private data: Record<string, string> = {};

  constructor(dir: string, private cipher: Cipher) {
    this.file = path.join(dir, 'secrets.bin.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  set(key: SecretKey, value: string) {
    if (this.cipher.isEncryptionAvailable()) {
      this.data[key] = 'enc:' + this.cipher.encryptString(value).toString('base64');
    } else {
      // Fallback (ex. Linux fără keyring) – marcat explicit ca neprotejat.
      this.data[key] = 'plain:' + Buffer.from(value, 'utf8').toString('base64');
    }
    this.persist();
  }

  get(key: SecretKey): string | null {
    const v = this.data[key];
    if (!v) return null;
    try {
      if (v.startsWith('enc:')) return this.cipher.decryptString(Buffer.from(v.slice(4), 'base64'));
      if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf8');
    } catch {
      return null;
    }
    return null;
  }

  getJson<T>(key: SecretKey): T | null {
    const s = this.get(key);
    if (!s) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }

  setJson(key: SecretKey, value: unknown) {
    this.set(key, JSON.stringify(value));
  }

  has(key: SecretKey) {
    return !!this.data[key];
  }

  clear(key: SecretKey) {
    delete this.data[key];
    this.persist();
  }
}
