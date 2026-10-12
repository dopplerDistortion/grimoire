// Dashboard sign-in codes (spec §20, Transport and auth): single use, and
// expired after ~60 s. start.test.ts covers the exchange over HTTP; the clock
// here is a fake, so the expiry needs no minute-long wait.
import { describe, expect, test } from 'vitest';
import { SignIns } from '../../../src/surfaces/start/sign-in';

describe('sign-in codes', () => {
  test('a code exchanged within ~60 s signs in; after that it is refused, and so is a spent one', () => {
    let now = 1_000_000;
    const signIns = new SignIns(() => now);
    const prompt = signIns.issueCode();
    const late = signIns.issueCode();

    now += 59_000;
    const signedIn = signIns.exchange(prompt);
    const spent = signIns.exchange(prompt);
    now += 2_000;
    const expired = signIns.exchange(late);

    expect(signedIn).not.toBeNull();
    expect(signIns.session(signedIn)).toEqual({ since: 1_059_000 });
    expect(spent).toBeNull();
    expect(expired).toBeNull();
  });
});
