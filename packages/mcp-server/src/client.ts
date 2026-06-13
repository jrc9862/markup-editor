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

  // --- History ---------------------------------------------------------------
  listVersions(docId: string) {
    return this.json('GET', `/api/docs/${docId}/versions`);
  }
}
