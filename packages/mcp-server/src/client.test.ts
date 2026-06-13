import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarkupClient, MarkupError } from './client.js';

/**
 * The client is a thin REST wrapper; these tests pin down exactly what goes
 * on the wire (method, URL, headers, body) and how responses/errors map back,
 * with a stubbed global fetch.
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Captured[] = [];

function stubFetch(
  responder: (c: Captured) => { status?: number; body: string },
) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const captured: Captured = {
      url,
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(captured);
    const { status = 200, body } = responder(captured);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      text: async () => body,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
}

const client = new MarkupClient({ server: 'http://srv:4000', token: 'tok-123' });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request construction', () => {
  it('sends a bearer token and no Content-Type on a GET', async () => {
    stubFetch(() => ({ body: '[]' }));
    await client.listDocs();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://srv:4000/api/docs');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe('Bearer tok-123');
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  it('sends a JSON body with Content-Type on a write', async () => {
    stubFetch(() => ({ body: '{"ok":true}' }));
    await client.writeDoc('d1', '# hi');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/content');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({ content: '# hi' });
  });
});

describe('response handling', () => {
  it('parses JSON responses', async () => {
    stubFetch(() => ({ body: '[{"docId":"d1"}]' }));
    const docs = await client.listDocs();
    expect(docs).toEqual([{ docId: 'd1' }]);
  });

  it('returns markdown snapshots as raw text', async () => {
    stubFetch(() => ({ body: '# Title\n\nbody' }));
    const md = await client.readDoc('d1');
    expect(md).toBe('# Title\n\nbody');
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/snapshot');
  });
});

describe('error handling', () => {
  it('throws MarkupError with status and the server error message', async () => {
    stubFetch(() => ({ status: 403, body: '{"error":"requires write access to this doc"}' }));
    await expect(client.writeDoc('d1', 'x')).rejects.toMatchObject({
      name: 'MarkupError',
      status: 403,
    });
    await expect(client.writeDoc('d1', 'x')).rejects.toThrow(
      /requires write access to this doc/,
    );
  });

  it('falls back to the raw text when an error body is not JSON', async () => {
    stubFetch(() => ({ status: 500, body: 'Internal Server Error' }));
    const err = await client.listDocs().catch((e) => e);
    expect(err).toBeInstanceOf(MarkupError);
    expect((err as MarkupError).message).toMatch(/Internal Server Error/);
  });
});

describe('range and author plumbing', () => {
  it('passes an anchorText range, proposed text and author on suggest', async () => {
    stubFetch(() => ({ status: 201, body: '{"id":"s1"}' }));
    const res = await client.suggest(
      'd1',
      { anchorText: 'foo', occurrence: 2 },
      'bar',
      'agent-bot',
    );
    expect(res).toEqual({ id: 's1' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/suggestions');
    expect(calls[0].body).toEqual({
      anchorText: 'foo',
      occurrence: 2,
      proposed: 'bar',
      author: 'agent-bot',
      from: undefined,
      to: undefined,
    });
  });

  it('passes from/to offsets on add_comment', async () => {
    stubFetch(() => ({ status: 201, body: '{"id":"c1"}' }));
    await client.addComment('d1', { from: 3, to: 8 }, 'note');
    expect(calls[0].body).toMatchObject({ from: 3, to: 8, text: 'note' });
  });

  it('targets the suggestion id on accept', async () => {
    stubFetch(() => ({ body: '{"ok":true}' }));
    await client.acceptSuggestion('d1', 's9');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/suggestions/s9/accept');
  });
});
