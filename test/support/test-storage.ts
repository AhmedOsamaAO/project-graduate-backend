import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_STORAGE_PREFIX = 'project-graduate-storage-';

export interface TestStorage {
  readonly path: string;
  remove(): Promise<void>;
}

/**
 * Creates a writable temporary storage directory outside the repository.
 * Call `remove()` during teardown to delete every file created by the test.
 */
export async function createTestStorage(): Promise<TestStorage> {
  const path = await mkdtemp(join(tmpdir(), TEST_STORAGE_PREFIX));
  let removed = false;

  return {
    path,
    async remove(): Promise<void> {
      if (removed) {
        return;
      }
      removed = true;
      await rm(path, { recursive: true, force: true });
    },
  };
}
