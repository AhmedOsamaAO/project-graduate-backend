import {
  clearCookieOptions,
  csrfCookieName,
  csrfCookieOptions,
  parseCookieValue,
  PRE_LOGIN_CSRF_TTL_MS,
  sessionCookieName,
  sessionCookieOptions,
} from './cookies';

describe('staff access cookies', () => {
  it('uses __Host- prefixed host-only Secure cookies when cookieSecure is true', () => {
    const config = { cookieSecure: true, sessionAbsoluteTimeoutDays: 7 };

    expect(sessionCookieName(config)).toBe('__Host-graduate_session');
    expect(csrfCookieName(config)).toBe('__Host-graduate_csrf');

    const sessOpts = sessionCookieOptions(config);
    expect(sessOpts).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    expect('domain' in sessOpts).toBe(false);

    const csrfOpts = csrfCookieOptions(config);
    expect(csrfOpts).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: PRE_LOGIN_CSRF_TTL_MS,
    });
    expect('domain' in csrfOpts).toBe(false);

    const clearOpts = clearCookieOptions(config);
    expect(clearOpts).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect('domain' in clearOpts).toBe(false);
    expect('maxAge' in clearOpts).toBe(false);
  });

  it('uses non-__Host- names with secure=false for explicit local development', () => {
    const config = { cookieSecure: false, sessionAbsoluteTimeoutDays: 3 };

    expect(sessionCookieName(config)).toBe('graduate_session');
    expect(csrfCookieName(config)).toBe('graduate_csrf');
    expect(sessionCookieOptions(config)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 3 * 24 * 60 * 60 * 1000,
    });
    expect(csrfCookieOptions(config)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: PRE_LOGIN_CSRF_TTL_MS,
    });
    expect(clearCookieOptions(config)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('parses cookies cleanly and rejects duplicate target cookie names', () => {
    expect(parseCookieValue(undefined, 'graduate_session')).toBeUndefined();
    expect(parseCookieValue('', 'graduate_session')).toBeUndefined();
    expect(
      parseCookieValue(
        'other=1; graduate_session=abc==; malformed; =noname; third=3',
        'graduate_session',
      ),
    ).toBe('abc==');
    expect(
      parseCookieValue(
        ['foo=bar', 'graduate_session=token-value'],
        'graduate_session',
      ),
    ).toBe('token-value');
    expect(
      parseCookieValue(
        'graduate_session=first; graduate_session=second',
        'graduate_session',
      ),
    ).toBeUndefined();
  });
});
