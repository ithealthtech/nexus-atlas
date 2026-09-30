import { describe, expect, it } from 'vitest';
import { matchLogin, siteOf } from '../src/services/login-match.js';

const page = (url: string) => siteOf(url)!;

describe('matching saved logins to pages', () => {
  it('matches the same host, then other hosts under the same registrable domain', () => {
    expect(matchLogin('https://portal.harbor.co.uk/login', page('https://PORTAL.harbor.co.uk./x'))).toBe('exact');
    expect(matchLogin('https://portal.harbor.co.uk', page('https://sso.harbor.co.uk'))).toBe('domain');
    expect(matchLogin('https://harbor.co.uk', page('https://www.harbor.co.uk'))).toBe('domain');
    // co.uk is a public suffix: two companies under it are unrelated.
    expect(matchLogin('https://harbor.co.uk', page('https://northline.co.uk'))).toBeNull();
    expect(matchLogin('https://portal.harbor.co.uk:8443', page('https://portal.harbor.co.uk'))).toBe('exact');
  });

  it('keeps shared hosting, IP addresses, and single-label names to exact matches', () => {
    expect(matchLogin('https://harbor.github.io', page('https://other.github.io'))).toBeNull();
    expect(matchLogin('https://harbor.azurewebsites.net', page('https://evil.azurewebsites.net'))).toBeNull();
    expect(matchLogin('https://10.20.0.1', page('https://10.20.0.1:4443/'))).toBe('exact');
    expect(matchLogin('https://10.20.0.1', page('https://10.20.0.2'))).toBeNull();
    expect(matchLogin('https://[fd00::1]/', page('https://[fd00::1]:8443'))).toBe('exact');
    expect(matchLogin('http://nas', page('http://nas:5000'))).toBe('exact');
    expect(matchLogin('http://nas', page('http://nas2'))).toBeNull();
  });

  it('never offers an https login to a plain-http page', () => {
    expect(matchLogin('https://portal.harbor.com', page('http://portal.harbor.com'))).toBeNull();
    expect(matchLogin('http://portal.harbor.com', page('https://portal.harbor.com'))).toBe('exact');
    // Addresses saved without a scheme (imports) are read as https.
    expect(matchLogin('portal.harbor.com', page('http://portal.harbor.com'))).toBeNull();
    expect(matchLogin('portal.harbor.com/login', page('https://portal.harbor.com'))).toBe('exact');
    expect(matchLogin('portal.harbor.com:8443', page('https://portal.harbor.com'))).toBe('exact');
  });

  it('ignores addresses that are not web pages', () => {
    for (const address of ['', 'ftp://files.harbor.com', 'mailto:it@harbor.com', 'chrome://settings', 'not a url'])
      expect(siteOf(address)).toBeNull();
    expect(matchLogin('', page('https://harbor.com'))).toBeNull();
  });
});
