import { Logger } from '@nestjs/common';
import { createApplication } from './bootstrap';
import type { AppConfig } from './config/app-config';
import { APP_CONFIG } from './config/app-config.module';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get<AppConfig>(APP_CONFIG);

  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    error instanceof Error ? error.message : 'Application failed to start',
  );
  process.exitCode = 1;
});
