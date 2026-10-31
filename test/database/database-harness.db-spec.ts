import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAppConfig } from '../../src/config/app-config';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createTestEnvironment,
  type TestEnvironment,
} from '../support/test-environment';
import { createTestStorage } from '../support/test-storage';

describe('isolated test harness', () => {
  let environment: TestEnvironment;
  let prisma: PrismaService;

  beforeAll(async () => {
    environment = await createTestEnvironment();

    prisma = new PrismaService(loadAppConfig());
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.onApplicationShutdown();
    }
    if (environment) {
      await environment.close();
    }
  });

  it('connects through Prisma to a disposable migrated database', async () => {
    const [{ currentDatabase }] = await prisma.$queryRaw<
      Array<{ currentDatabase: string }>
    >`SELECT current_database() AS "currentDatabase"`;

    expect(currentDatabase).toBe(environment.database.name);

    const migrations = await prisma.$queryRaw<
      Array<{ migrationName: string; finishedAt: Date | null }>
    >`
      SELECT migration_name AS "migrationName", finished_at AS "finishedAt"
      FROM "_prisma_migrations"
      ORDER BY started_at
    `;

    expect(migrations.map((migration) => migration.migrationName)).toContain(
      '20261031120000_baseline',
    );
    expect(migrations.every((migration) => migration.finishedAt !== null)).toBe(
      true,
    );
  });

  it('creates a writable temporary storage directory outside the repository', async () => {
    const { path } = environment.storage;
    await writeFile(join(path, 'probe.txt'), 'isolated');

    expect(await readFile(join(path, 'probe.txt'), 'utf8')).toBe('isolated');
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path.startsWith(process.cwd())).toBe(false);
  });

  it('removes the temporary storage directory', async () => {
    const disposable = await createTestStorage();
    await disposable.remove();

    await expect(stat(disposable.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
