import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MarkupClient } from './client.js';
import { createMcpServer, TOOL_NAMES } from './server.js';

/**
 * End-to-end through the real MCP machinery: a Client talks to the registered
 * server over a linked in-memory transport, so these exercise tool discovery,
 * argument validation (zod), and the ok()/run() result formatting. The only
 * thing stubbed is the network (global fetch), so we also assert what each
 * tool puts on the wire.
 */

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

let calls: Captured[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: '{}' };

function setResponse(body: string, status = 200) {
  nextResponse = { status, body };
}

function firstText(result: { content: { type: string; text: string }[] }): string {
  return result.content[0].text;
}

let mcp: Client;

beforeEach(async () => {
  calls = [];
  setResponse('{}');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      const { status, body } = nextResponse;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: `status ${status}`,
        text: async () => body,
      } as Response;
    }),
  );

  const markup = new MarkupClient({ server: 'http://srv:4000', token: 'tok' });
  const server = createMcpServer(markup, { defaultAuthor: 'fallback-bot' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: 'test', version: '0' });
  await Promise.all([
    server.connect(serverTransport),
    mcp.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await mcp.close();
  vi.unstubAllGlobals();
});

describe('tool discovery', () => {
  it('registers exactly the documented tool set', async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it('exposes input schemas for range tools', async () => {
    const { tools } = await mcp.listTools();
    const suggest = tools.find((t) => t.name === 'suggest')!;
    const props = (suggest.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['docId', 'from', 'to', 'anchorText', 'occurrence', 'proposed']),
    );
  });
});

describe('tool calls', () => {
  it('list_docs returns the server payload as pretty JSON text', async () => {
    setResponse('[{"docId":"d1","name":"a.md"}]');
    const res = await mcp.callTool({ name: 'list_docs', arguments: {} });
    expect(calls[0].url).toBe('http://srv:4000/api/docs');
    expect(JSON.parse(firstText(res as never))).toEqual([{ docId: 'd1', name: 'a.md' }]);
    expect((res as { isError?: boolean }).isError).toBeFalsy();
  });

  it('suggest forwards anchorText/proposed and applies the fallback author', async () => {
    setResponse('{"id":"s1"}', 201);
    const res = await mcp.callTool({
      name: 'suggest',
      arguments: { docId: 'd1', anchorText: 'foo', proposed: 'bar' },
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/suggestions');
    expect(calls[0].body).toMatchObject({
      anchorText: 'foo',
      proposed: 'bar',
      author: 'fallback-bot',
    });
    expect(JSON.parse(firstText(res as never))).toEqual({ id: 's1' });
  });

  it('read_doc surfaces markdown text verbatim', async () => {
    setResponse('# Heading\n\ntext');
    const res = await mcp.callTool({ name: 'read_doc', arguments: { docId: 'd1' } });
    expect(firstText(res as never)).toBe('# Heading\n\ntext');
  });

  it('maps a server 403 to an error result carrying the message', async () => {
    setResponse('{"error":"requires write access to this doc"}', 403);
    const res = (await mcp.callTool({
      name: 'write_doc',
      arguments: { docId: 'd1', content: 'x' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/403/);
    expect(res.content[0].text).toMatch(/requires write access/);
  });

  it('rejects a call that violates the input schema (missing docId)', async () => {
    const res = (await mcp.callTool({
      name: 'get_doc',
      arguments: {},
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    // No network call should have happened — validation failed first.
    expect(calls).toHaveLength(0);
  });

  it('accept_suggestion hits the accept route for the given id', async () => {
    setResponse('{"ok":true}');
    await mcp.callTool({
      name: 'accept_suggestion',
      arguments: { docId: 'd1', suggestionId: 's7' },
    });
    expect(calls[0].url).toBe('http://srv:4000/api/docs/d1/suggestions/s7/accept');
  });
});
