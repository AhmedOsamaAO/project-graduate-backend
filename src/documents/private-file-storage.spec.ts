import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/app-config';
import { ERROR_CODES } from '../common/errors/error-codes';
import { PrivateFileStorage } from './private-file-storage';

function makeConfig(privateStorageRoot: string): AppConfig {
  return {
    environment: 'test',
    isProduction: false,
    databaseUrl: 'postgresql://user:pass@localhost:5432/db',
    port: 3000,
    host: '127.0.0.1',
    frontendOrigins: ['http://localhost:5173'],
    cookieSecure: false,
    csrfMode: 'synchronizer',
    sessionIdleTimeoutMinutes: 120,
    sessionAbsoluteTimeoutDays: 7,
    sessionCleanupIntervalMinutes: 15,
    privateStorageRoot,
    uploadMaxBytes: 10 * 1024 * 1024,
    fileOperationReconciliationIntervalSeconds: 60,
    fileOperationLeaseSeconds: 120,
  };
}

describe('PrivateFileStorage', () => {
  let rootDir: string;
  let storage: PrivateFileStorage;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'private-file-storage-spec-'));
    storage = new PrivateFileStorage(makeConfig(rootDir));
    await storage.ensureDirectories();
  });

  afterEach(async () => {
    await chmod(join(rootDir, 'objects'), 0o700).catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('creates staging and objects directories and generates distinct 64-hex keys', async () => {
    const stagingStat = await lstat(join(rootDir, 'staging'));
    const objectsStat = await lstat(join(rootDir, 'objects'));
    expect(stagingStat.isDirectory()).toBe(true);
    expect(objectsStat.isDirectory()).toBe(true);

    const k1 = storage.generateKey();
    const k2 = storage.generateKey();
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).not.toBe(k2);
  });

  it('rejects non-hex keys and path traversal attempts without touching disk', () => {
    for (const badKey of [
      '',
      '../etc/passwd',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      `${'0'.repeat(62)}/1`,
    ]) {
      expect(() => storage.stagingPath(badKey)).toThrow();
      expect(() => storage.objectPath(badKey)).toThrow();
    }
  });

  it('opens exclusive staging files, promotes to objects with fsync, and cleans up idempotently', async () => {
    const stagingKey = storage.generateKey();
    const storageKey = storage.generateKey();
    const payload = Buffer.from('immutable-document-bytes', 'utf8');

    const handle = await storage.openExclusiveStagingFile(stagingKey);
    await handle.writeFile(payload);
    await storage.fsyncAndClose(handle);

    // O_EXCL refuses opening the same staging key twice
    await expect(
      storage.openExclusiveStagingFile(stagingKey),
    ).rejects.toThrow();

    await storage.promoteStagingToObject(stagingKey, storageKey);

    expect(await readdir(join(rootDir, 'staging'))).toEqual([]);
    expect(await readdir(join(rootDir, 'objects'))).toEqual([storageKey]);
    expect(await readFile(storage.objectPath(storageKey))).toEqual(payload);

    // Readable stream returns exact payload
    const stream = await storage.openReadableObject(storageKey, payload.length);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    expect(Buffer.concat(chunks)).toEqual(payload);

    // Remove and re-remove (ENOENT tolerant)
    await storage.removeArtifactIfExists('objects', storageKey);
    await storage.removeArtifactIfExists('objects', storageKey);
    expect(await readdir(join(rootDir, 'objects'))).toEqual([]);
  });

  it('maps missing files, size mismatches, and symlinks to sanitized 503 FILE_STORAGE_UNAVAILABLE without leaking keys or paths', async () => {
    const missingKey = storage.generateKey();
    await expect(
      storage.openReadableObject(missingKey, 100),
    ).rejects.toMatchObject({
      status: 503,
      code: ERROR_CODES.FILE_STORAGE_UNAVAILABLE,
    });

    try {
      await storage.openReadableObject(missingKey, 100);
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain(rootDir);
      expect(msg).not.toContain(missingKey);
    }

    const mismatchKey = storage.generateKey();
    await writeFile(storage.objectPath(mismatchKey), Buffer.from('12345'));
    await expect(
      storage.openReadableObject(mismatchKey, 999),
    ).rejects.toMatchObject({
      status: 503,
      code: ERROR_CODES.FILE_STORAGE_UNAVAILABLE,
    });

    const linkTarget = join(rootDir, 'outside.txt');
    await writeFile(linkTarget, Buffer.from('secret'));
    const linkKey = storage.generateKey();
    await symlink(linkTarget, storage.objectPath(linkKey));
    await expect(storage.openReadableObject(linkKey, 6)).rejects.toMatchObject({
      status: 503,
      code: ERROR_CODES.FILE_STORAGE_UNAVAILABLE,
    });
  });

  it('propagates real filesystem errors when removing un-unlikable artifacts', async () => {
    const key = storage.generateKey();
    await writeFile(storage.objectPath(key), Buffer.from('data'));
    await chmod(join(rootDir, 'objects'), 0o500);

    // If running as non-root, chmod 0o500 causes EACCES on unlink.
    if (process.getuid && process.getuid() !== 0) {
      await expect(
        storage.removeArtifactIfExists('objects', key),
      ).rejects.toThrow();
    }
  });
});
