export class PageResult<T> {
  constructor(
    readonly items: readonly T[],
    readonly total: number,
    readonly page: number,
    readonly pageSize: number,
  ) {}
}

export function createPage<T>(
  items: readonly T[],
  total: number,
  page: number,
  pageSize: number,
): PageResult<T> {
  return new PageResult(items, total, page, pageSize);
}

export function isPageResult(value: unknown): value is PageResult<unknown> {
  return value instanceof PageResult;
}
