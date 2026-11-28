import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { constants, type ReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../common/errors/api-error';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/app-config.module';

const STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export type StorageArea = 'staging' | 'objects';

@Injectable()
export class PrivateFileStorage {
  private readonly rootDir: string;
  private readonly stagingDir: string;
  private readonly objectsDir: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.rootDir = resolve(config.privateStorageRoot);
    this.stagingDir = join(this.rootDir, 'staging');
    this.objectsDir = join(this.rootDir, 'objects');
  }

  generateKey(): string {
    return randomBytes(32).toString('hex');
  }

  async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });

    await assertRealDirectory(this.rootDir);
    await assertRealDirectory(this.stagingDir);
    await assertRealDirectory(this.objectsDir);

    await fsyncDirectory(this.rootDir);
    await fsyncDirectory(this.stagingDir);
    await fsyncDirectory(this.objectsDir);
  }

  stagingPath(stagingKey: string): string {
    return this.resolveContainedPath(this.stagingDir, stagingKey, 'stagingKey');
  }

  objectPath(storageKey: string): string {
    return this.resolveContainedPath(this.objectsDir, storageKey, 'storageKey');
  }

  openExclusiveStagingFile(stagingKey: string): Promise<FileHandle> {
    const path = this.stagingPath(stagingKey);
    const flags =
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0);
    return open(path, flags, 0o600);
  }

  async fsyncAndClose(handle: FileHandle): Promise<void> {
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async promoteStagingToObject(
    stagingKey: string,
    storageKey: string,
  ): Promise<void> {
    const sourcePath = this.stagingPath(stagingKey);
    const destinationPath = this.objectPath(storageKey);

    const existing = await lstat(destinationPath).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) {
        return null;
      }
      throw error;
    });
    if (existing !== null) {
      throw new Error('Refusing to overwrite an existing stored file artifact');
    }

    await rename(sourcePath, destinationPath);
    await fsyncRegularFile(destinationPath);
    await fsyncDirectory(this.objectsDir);
    await fsyncDirectory(this.stagingDir);
  }

  async removeArtifactIfExists(area: StorageArea, key: string): Promise<void> {
    const dir = area === 'staging' ? this.stagingDir : this.objectsDir;
    const path = this.resolveContainedPath(
      dir,
      key,
      area === 'staging' ? 'stagingKey' : 'storageKey',
    );
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    await fsyncDirectory(dir);
  }

  async openReadableObject(
    storageKey: string,
    expectedByteSize: number,
  ): Promise<ReadStream> {
    let path: string;
    try {
      path = this.objectPath(storageKey);
    } catch {
      throw fileStorageUnavailableError();
    }

    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    let handle: FileHandle;
    try {
      handle = await open(path, flags);
    } catch {
      throw fileStorageUnavailableError();
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expectedByteSize) {
        await handle.close().catch(() => undefined);
        throw fileStorageUnavailableError();
      }
      const stream = handle.createReadStream({ autoClose: true });
      stream.once('close', () => {
        void handle.close().catch(() => undefined);
      });
      return stream;
    } catch (error: unknown) {
      await handle.close().catch(() => undefined);
      if (error instanceof ApiError) {
        throw error;
      }
      throw fileStorageUnavailableError();
    }
  }

  private resolveContainedPath(
    baseDir: string,
    key: string,
    label: string,
  ): string {
    if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid ${label}`);
    }
    const candidate = resolve(baseDir, key);
    const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
    if (!candidate.startsWith(prefix)) {
      throw new Error(`Unsafe ${label} path`);
    }
    return candidate;
  }
}

export function fileStorageUnavailableError(): ApiError {
  return new ApiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    ERROR_CODES.FILE_STORAGE_UNAVAILABLE,
    'Document file is temporarily unavailable',
  );
}

async function assertRealDirectory(dirPath: string): Promise<void> {
  const info = await lstat(dirPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Private storage location must be a real directory');
  }
}

async function fsyncRegularFile(filePath: string): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  const flags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(dirPath, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
