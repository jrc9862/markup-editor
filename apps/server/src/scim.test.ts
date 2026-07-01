import { describe, it, expect } from 'vitest';
import { parseScimFilter } from './scim.js';

describe('parseScimFilter', () => {
  it('parses the `attr eq "value"` form IdPs send before create', () => {
    expect(parseScimFilter('userName eq "a@example.com"')).toEqual({
      attr: 'userName',
      value: 'a@example.com',
    });
    expect(parseScimFilter('displayName eq "Eng Team"')).toEqual({
      attr: 'displayName',
      value: 'Eng Team',
    });
    expect(parseScimFilter('externalId eq "idp-1"')).toEqual({
      attr: 'externalId',
      value: 'idp-1',
    });
  });

  it('tolerates surrounding whitespace and unescapes quotes', () => {
    expect(parseScimFilter('  userName eq "x"  ')).toEqual({
      attr: 'userName',
      value: 'x',
    });
    expect(parseScimFilter('displayName eq "a\\"b"')).toEqual({
      attr: 'displayName',
      value: 'a"b',
    });
  });

  it('returns null for empty or unsupported filters (caller lists all)', () => {
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter('')).toBeNull();
    expect(parseScimFilter('userName co "x"')).toBeNull();
    expect(parseScimFilter('userName eq x')).toBeNull();
  });
});
