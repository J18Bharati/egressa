import { describe, expect, it } from 'vitest';
import { isReservedHost } from './reserved-host.js';

describe('isReservedHost', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    'example.com',
    'db.example.com',
    'example.org',
    'api.example.net',
    'service.test',
    'foo.example',
    'nowhere.invalid',
  ])('treats %s as a name no third party can hold', (host) => {
    expect(isReservedHost(host)).toBe(true);
  });

  it.each([
    // Private ranges can be a vendor appliance inside a VPC: left for a human.
    '10.0.0.5',
    '192.168.1.1',
    '0.0.0.0',
    'clerk.acme.internal',
    // Look-alikes are real registrable names.
    'example.co',
    'notexample.com',
    'example.com.evil.io',
    'localhost.io',
    'testing.dev',
    '1270.0.0.1',
  ])('leaves %s to be reported', (host) => {
    expect(isReservedHost(host)).toBe(false);
  });
});
