interface AdapterErrorCause {
  readonly code?: string;
  readonly originalCode?: string;
}

interface PrismaErrorLike {
  readonly code?: string;
  readonly cause?: AdapterErrorCause;
  readonly meta?: {
    readonly code?: string;
    readonly driverAdapterError?: { readonly cause?: AdapterErrorCause };
  };
}

function hasDatabaseCode(
  error: unknown,
  targets: ReadonlySet<string>,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as PrismaErrorLike;
  const driverCause = candidate.meta?.driverAdapterError?.cause;
  return [
    candidate.code,
    candidate.cause?.originalCode,
    candidate.cause?.code,
    candidate.meta?.code,
    driverCause?.originalCode,
    driverCause?.code,
  ].some((code) => code !== undefined && targets.has(code));
}

const UNIQUE_CONSTRAINT_CODES = new Set(['P2002', '23505']);
const FOREIGN_KEY_CONSTRAINT_CODES = new Set(['P2003', '23503', '23001']);

export function isUniqueConstraintError(error: unknown): boolean {
  return hasDatabaseCode(error, UNIQUE_CONSTRAINT_CODES);
}

export function isForeignKeyConstraintError(error: unknown): boolean {
  return hasDatabaseCode(error, FOREIGN_KEY_CONSTRAINT_CODES);
}
