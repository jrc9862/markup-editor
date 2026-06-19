/**
 * Thin HTTP client for the Markup REST agent surface. Every method maps to a
 * route in apps/server (see CLAUDE.md "Agent surface"); the server enforces
 * token scope and per-doc role, so a tool that the credentials aren't allowed
 * to use simply surfaces the server's 403.
 */

export interface ClientConfig {
  /** Base URL of the markup server REST API, e.g. http://localhost:4000. */
  server: string;
  /** Bearer token: an mkp_ API token (preferred) or the legacy shared token. */
  token: string;
}

/** A character range, given as offsets OR by quoting the text to anchor to. */
export interface Range {
  from?: number;
  to?: number;
  anchorText?: string;
  occurrence?: number;
}

export class MarkupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MarkupError';
  }
}

export class MarkupClient {
  constructor(private readonly cfg: ClientConfig) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ json: unknown; text: string }> {
    const res = await fetch(`${this.cfg.server}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON responses (markdown snapshots/versions) keep `text`.
    }
    if (!res.ok) {
      const msg =
        (json as { error?: string } | undefined)?.error ??
        text ??
        res.statusText;
      throw new MarkupError(`${method} ${path} -> ${res.status}: ${msg}`, res.status);
    }
    return { json, text };
  }

  private json(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body).then((r) => r.json);
  }

  // --- Identity --------------------------------------------------------------
  me() {
    return this.json('GET', '/api/me');
  }

  // --- Documents -------------------------------------------------------------
  listDocs() {
    return this.json('GET', '/api/docs');
  }
  getDoc(docId: string) {
    return this.json('GET', `/api/docs/${docId}`);
  }
  /** The document's current markdown as plain text. */
  async readDoc(docId: string): Promise<string> {
    const { text } = await this.request('GET', `/api/docs/${docId}/snapshot`);
    return text;
  }
  writeDoc(docId: string, content: string) {
    return this.json('PUT', `/api/docs/${docId}/content`, { content });
  }

  // --- Comments --------------------------------------------------------------
  listComments(docId: string) {
    return this.json('GET', `/api/docs/${docId}/comments`);
  }
  addComment(docId: string, range: Range, text: string, author?: string) {
    return this.json('POST', `/api/docs/${docId}/comments`, { ...range, text, author });
  }
  replyComment(docId: string, threadId: string, text: string, author?: string) {
    return this.json('POST', `/api/docs/${docId}/comments/${threadId}/replies`, {
      text,
      author,
    });
  }
  resolveComment(docId: string, threadId: string, resolved: boolean) {
    return this.json('POST', `/api/docs/${docId}/comments/${threadId}/resolve`, {
      resolved,
    });
  }

  // --- Suggestions -----------------------------------------------------------
  listSuggestions(docId: string) {
    return this.json('GET', `/api/docs/${docId}/suggestions`);
  }
  suggest(docId: string, range: Range, proposed: string, author?: string) {
    return this.json('POST', `/api/docs/${docId}/suggestions`, {
      ...range,
      proposed,
      author,
    });
  }
  updateSuggestion(
    docId: string,
    sid: string,
    from: number,
    to: number,
    proposed: string,
  ) {
    return this.json('PUT', `/api/docs/${docId}/suggestions/${sid}`, {
      from,
      to,
      proposed,
    });
  }
  withdrawSuggestion(docId: string, sid: string) {
    return this.json('DELETE', `/api/docs/${docId}/suggestions/${sid}`);
  }
  acceptSuggestion(docId: string, sid: string) {
    return this.json('POST', `/api/docs/${docId}/suggestions/${sid}/accept`);
  }
  rejectSuggestion(docId: string, sid: string) {
    return this.json('POST', `/api/docs/${docId}/suggestions/${sid}/reject`);
  }
  replySuggestion(docId: string, sid: string, text: string, author?: string) {
    return this.json('POST', `/api/docs/${docId}/suggestions/${sid}/replies`, {
      text,
      author,
    });
  }

  // --- Multi-edits -----------------------------------------------------------
  /** Batch find/replace or an explicit list of range edits, applied atomically. */
  multiEdit(
    docId: string,
    body:
      | { find: string; replace: string; regex?: boolean; caseSensitive?: boolean }
      | { edits: Array<{ from: number; to: number; insert: string }> },
  ) {
    return this.json('POST', `/api/docs/${docId}/edits`, body);
  }

  /** PR-style batch review: accept and/or reject open suggestions atomically. */
  reviewSuggestions(docId: string, accept: string[], reject: string[]) {
    return this.json('POST', `/api/docs/${docId}/suggestions/review`, {
      accept,
      reject,
    });
  }

  // --- Git-native flows ------------------------------------------------------
  gitStatus() {
    return this.json('GET', '/api/git/status');
  }
  gitCommit(message: string, paths?: string[]) {
    return this.json('POST', '/api/git/commit', { message, paths });
  }
  gitBranch(name: string, checkout = true) {
    return this.json('POST', '/api/git/branch', { name, checkout });
  }

  // --- History ---------------------------------------------------------------
  listVersions(docId: string) {
    return this.json('GET', `/api/docs/${docId}/versions`);
  }

  // --- Events (SSE) ----------------------------------------------------------
  /**
   * Subscribe to the doc's realtime event stream and collect events until
   * `timeoutMs` elapses or `max` events arrive — the polling-free way for an
   * agent to react to comments, suggestions, reviews, and mentions.
   */
  async watchEvents(
    docId: string,
    opts: { timeoutMs?: number; max?: number } = {},
  ): Promise<unknown[]> {
    const timeoutMs = opts.timeoutMs ?? 25_000;
    const max = opts.max ?? 50;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const events: unknown[] = [];
    try {
      const res = await fetch(`${this.cfg.server}/api/docs/${docId}/events`, {
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'text/event-stream',
        },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new MarkupError(
          `GET /api/docs/${docId}/events -> ${res.status}`,
          res.status,
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (events.length < max) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) {
              try {
                events.push(JSON.parse(line.slice(5).trim()));
              } catch {
                // skip heartbeats / malformed frames
              }
            }
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) throw e;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    return events;
  }
}
