import { LoginThrottler } from './login-throttler';

describe('LoginThrottler', () => {
  it('throttles repeated failures for an attempted username across distinct IPs and clears after the window', () => {
    const throttler = new LoginThrottler({
      windowMs: 60_000,
      maxUsernameAttempts: 3,
      maxIpAttempts: 10,
    });
    const t0 = new Date('2026-11-20T12:00:00.000Z');

    throttler.recordFailure('10.0.0.1', '  Office.User ', t0);
    throttler.recordFailure(
      '10.0.0.2',
      'office.user',
      new Date(t0.getTime() + 1_000),
    );
    expect(
      throttler.check(
        '10.0.0.3',
        'office.user',
        new Date(t0.getTime() + 2_000),
      ),
    ).toEqual({
      allowed: true,
    });

    throttler.recordFailure(
      '10.0.0.3',
      'OFFICE.USER',
      new Date(t0.getTime() + 2_000),
    );

    expect(
      throttler.check(
        '10.0.0.4',
        'office.user',
        new Date(t0.getTime() + 10_000),
      ),
    ).toEqual({
      allowed: false,
      retryAfterSeconds: 50,
    });

    // Different username from a fresh IP is unaffected.
    expect(
      throttler.check(
        '10.0.0.4',
        'other.user',
        new Date(t0.getTime() + 10_000),
      ),
    ).toEqual({
      allowed: true,
    });

    // Once the oldest attempt falls outside the sliding window, login is allowed again (no permanent lockout).
    expect(
      throttler.check(
        '10.0.0.4',
        'office.user',
        new Date(t0.getTime() + 60_000),
      ),
    ).toEqual({
      allowed: true,
    });
  });

  it('throttles repeated failures by normalized client IP across distinct usernames', () => {
    const throttler = new LoginThrottler({
      windowMs: 60_000,
      maxUsernameAttempts: 5,
      maxIpAttempts: 3,
    });
    const t0 = new Date('2026-11-20T12:00:00.000Z');

    throttler.recordFailure('::ffff:127.0.0.1', 'user1', t0);
    throttler.recordFailure(
      '127.0.0.1',
      'user2',
      new Date(t0.getTime() + 1_000),
    );
    throttler.recordFailure(
      '::ffff:127.0.0.1',
      'user3',
      new Date(t0.getTime() + 2_000),
    );

    expect(
      throttler.check('127.0.0.1', 'user4', new Date(t0.getTime() + 5_000)),
    ).toEqual({
      allowed: false,
      retryAfterSeconds: 55,
    });
    expect(
      throttler.check('127.0.0.2', 'user4', new Date(t0.getTime() + 5_000)),
    ).toEqual({
      allowed: true,
    });
  });

  it('clears the username bucket on success without clearing IP throttling and bounds bucket keys', () => {
    const throttler = new LoginThrottler({
      windowMs: 60_000,
      maxUsernameAttempts: 2,
      maxIpAttempts: 3,
      maxKeys: 2,
    });
    const t0 = new Date('2026-11-20T12:00:00.000Z');

    throttler.recordFailure('10.0.0.1', 'alice', t0);
    throttler.recordFailure(
      '10.0.0.1',
      'alice',
      new Date(t0.getTime() + 1_000),
    );
    expect(
      throttler.check('10.0.0.2', 'alice', new Date(t0.getTime() + 2_000)),
    ).toMatchObject({
      allowed: false,
    });

    throttler.clearUsername('Alice');
    expect(
      throttler.check('10.0.0.2', 'alice', new Date(t0.getTime() + 2_000)),
    ).toEqual({
      allowed: true,
    });

    // IP still had 2 recorded failures, so one more failure hits maxIpAttempts=3.
    throttler.recordFailure('10.0.0.1', 'bob', new Date(t0.getTime() + 3_000));
    expect(
      throttler.check('10.0.0.1', 'charlie', new Date(t0.getTime() + 4_000)),
    ).toMatchObject({
      allowed: false,
    });

    // Adding enough new keys evicts the oldest key so memory stays bounded.
    throttler.recordFailure('10.0.0.8', 'dave', new Date(t0.getTime() + 5_000));
    throttler.recordFailure('10.0.0.9', 'eve', new Date(t0.getTime() + 6_000));
    expect(
      throttler.check('10.0.0.1', 'charlie', new Date(t0.getTime() + 7_000)),
    ).toEqual({
      allowed: true,
    });

    throttler.sweep(new Date(t0.getTime() + 70_000));
    expect(
      throttler.check('10.0.0.9', 'eve', new Date(t0.getTime() + 70_000)),
    ).toEqual({
      allowed: true,
    });
  });
});
