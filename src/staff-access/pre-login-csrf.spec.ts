import { PreLoginCsrfStore } from './pre-login-csrf';

describe('PreLoginCsrfStore', () => {
  it('issues distinct cookie and header tokens that verify before expiry', () => {
    const store = new PreLoginCsrfStore({ ttlMs: 60_000 });
    const issuedAt = new Date('2026-11-20T12:00:00.000Z');

    const issued = store.issue(issuedAt);

    expect(issued.cookieValue).not.toBe(issued.csrfToken);
    expect(
      Buffer.from(issued.cookieValue, 'base64url').length,
    ).toBeGreaterThanOrEqual(32);
    expect(
      Buffer.from(issued.csrfToken, 'base64url').length,
    ).toBeGreaterThanOrEqual(32);
    expect(
      store.verify(
        issued.cookieValue,
        issued.csrfToken,
        new Date(issuedAt.getTime() + 59_999),
      ),
    ).toBe(true);
    expect(store.verify(issued.cookieValue, 'wrong-token', issuedAt)).toBe(
      false,
    );
    expect(store.verify(undefined, issued.csrfToken, issuedAt)).toBe(false);
    expect(store.verify(issued.cookieValue, undefined, issuedAt)).toBe(false);
  });

  it('expires pre-login CSRF state at the TTL boundary', () => {
    const store = new PreLoginCsrfStore({ ttlMs: 10_000 });
    const issuedAt = new Date('2026-11-20T12:00:00.000Z');
    const issued = store.issue(issuedAt);

    expect(
      store.verify(
        issued.cookieValue,
        issued.csrfToken,
        new Date(issuedAt.getTime() + 10_000),
      ),
    ).toBe(false);
    expect(store.verify(issued.cookieValue, issued.csrfToken, issuedAt)).toBe(
      false,
    );
  });

  it('prevents replay after consume and bounds memory by evicting oldest entries', () => {
    const store = new PreLoginCsrfStore({ ttlMs: 60_000, maxEntries: 2 });
    const now = new Date('2026-11-20T12:00:00.000Z');

    const first = store.issue(now);
    const second = store.issue(now);
    const third = store.issue(now);

    expect(store.verify(first.cookieValue, first.csrfToken, now)).toBe(false);
    expect(store.verify(second.cookieValue, second.csrfToken, now)).toBe(true);
    expect(store.verify(third.cookieValue, third.csrfToken, now)).toBe(true);

    store.consume(second.cookieValue);
    expect(store.verify(second.cookieValue, second.csrfToken, now)).toBe(false);

    store.sweep(new Date(now.getTime() + 60_000));
    expect(store.verify(third.cookieValue, third.csrfToken, now)).toBe(false);
  });
});
