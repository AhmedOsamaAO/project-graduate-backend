import { config } from 'dotenv';

let loaded = false;

/**
 * Loads local `.env` values once for the application entry point. Existing
 * process variables always win, which lets tests load their own environment
 * first and lets production configuration come from the service manager.
 */
export function loadEnvironment(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  config({ quiet: true });
}
