export interface PageResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export function createPage<T>(
  items: readonly T[],
  total: number,
  page: number,
  pageSize: number,
): PageResult<T> {
  return { items, total, page, pageSize };
}

export function isPageResult<T>(value: unknown): value is PageResult<T> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.total === 'number' &&
    typeof candidate.page === 'number' &&
    typeof candidate.pageSize === 'number'
  );
}
