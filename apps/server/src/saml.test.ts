import { afterEach, describe, it, expect } from 'vitest';
import type { Profile } from '@node-saml/node-saml';
import { identityFromProfile, samlFromEnv } from './saml.js';

const SAML_ENV = [
  'SAML_ENTRY_POINT',
  'SAML_IDP_CERT',
  'SAML_ISSUER',
  'SAML_CALLBACK_URL',
  'SAML_AUDIENCE',
  'SAML_IDENTIFIER_FORMAT',
] as const;

function clearEnv() {
  for (const k of SAML_ENV) delete process.env[k];
}

// A minimally-shaped validated assertion. node-saml's Profile requires a few
// fields; the tests only exercise attribute extraction.
function profile(extra: Record<string, unknown>): Profile {
  return {
    issuer: 'idp',
    nameID: 'n',
    nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    ...extra,
  } as Profile;
}

describe('samlFromEnv', () => {
  afterEach(clearEnv);

  it('returns null unless both the endpoint and cert are set', () => {
    clearEnv();
    expect(samlFromEnv('http://localhost:4000')).toBeNull();
    process.env.SAML_ENTRY_POINT = 'https://idp.example/sso';
    expect(samlFromEnv('http://localhost:4000')).toBeNull();
    delete process.env.SAML_ENTRY_POINT;
    process.env.SAML_IDP_CERT = 'CERT';
    expect(samlFromEnv('http://localhost:4000')).toBeNull();
  });

  it('derives issuer/callback/audience defaults from the server origin', () => {
    clearEnv();
    process.env.SAML_ENTRY_POINT = 'https://idp.example/sso';
    process.env.SAML_IDP_CERT = 'CERT';
    const cfg = samlFromEnv('https://markup.example');
    expect(cfg).toMatchObject({
      entryPoint: 'https://idp.example/sso',
      idpCert: 'CERT',
      issuer: 'https://markup.example',
      callbackUrl: 'https://markup.example/auth/saml/callback',
      audience: 'https://markup.example',
      identifierFormat:
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
  });

  it('honours explicit overrides and normalizes an escaped-newline cert', () => {
    clearEnv();
    process.env.SAML_ENTRY_POINT = 'https://idp.example/sso';
    process.env.SAML_IDP_CERT = '-----BEGIN-----\\nabc\\n-----END-----';
    process.env.SAML_ISSUER = 'my-sp';
    process.env.SAML_CALLBACK_URL = 'https://acs.example/cb';
    process.env.SAML_AUDIENCE = 'aud';
    const cfg = samlFromEnv('https://markup.example')!;
    expect(cfg.issuer).toBe('my-sp');
    expect(cfg.callbackUrl).toBe('https://acs.example/cb');
    expect(cfg.audience).toBe('aud');
    expect(cfg.idpCert).toBe('-----BEGIN-----\nabc\n-----END-----');
  });
});

describe('identityFromProfile', () => {
  it('reads the canonical email attribute and display name', () => {
    expect(
      identityFromProfile(profile({ email: 'Jane@Example.com', displayName: 'Jane Doe' })),
    ).toEqual({ email: 'jane@example.com', name: 'Jane Doe' });
  });

  it('falls back through mail, OIDs, and given+surname', () => {
    expect(
      identityFromProfile(
        profile({
          'urn:oid:0.9.2342.19200300.100.1.3': 'bob@corp.io',
          'urn:oid:2.5.4.42': 'Bob',
          'urn:oid:2.5.4.4': 'Smith',
        }),
      ),
    ).toEqual({ email: 'bob@corp.io', name: 'Bob Smith' });
  });

  it('uses the NameID when it is an email and no attribute carries one', () => {
    expect(
      identityFromProfile(profile({ nameID: 'carol@team.dev' })),
    ).toEqual({ email: 'carol@team.dev', name: 'carol' });
  });

  it('picks the first value from a multi-valued attribute', () => {
    expect(
      identityFromProfile(profile({ email: ['first@x.io', 'second@x.io'] })),
    ).toEqual({ email: 'first@x.io', name: 'first' });
  });

  it('throws when no email can be resolved', () => {
    expect(() =>
      identityFromProfile(profile({ nameID: 'not-an-email', displayName: 'X' })),
    ).toThrow(/no email/i);
  });
});
