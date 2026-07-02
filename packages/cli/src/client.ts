import * as Y from 'yjs';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import WebSocket from 'ws';
import { CONTENT_FIELD, applyStringToYText } from '@markup/sync-core';
import { SERVER_WS, TOKEN } from './config.js';
import { loadState, saveState } from './state.js';
import { DISK_ORIGIN } from './daemon.js';

export interface DocConnection {
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  close: () => void;
}

export interface ConnectOptions {
  /**
   * Persist/restore the Yjs doc under .markup/state so offline edits survive a
   * restart and CRDT-merge on reconnect instead of being lost to server-wins.
   */
  persist?: boolean;
  /**
   * Disk content to fold into the doc *before* connecting, so edits made while
   * offline are part of the initial sync and three-way-merge with the server.
   * Only meaningful alongside `persist` (we need a persisted base to diff
   * against — see index.ts for the cold-start guard).
   */
  seedDisk?: string;
}

/**
 * Resolve once the provider has flushed every pending local change to the
 * server (`unsyncedChanges` reaches 0), or after `timeoutMs` on a flaky link
 * so one-shot commands still terminate. Resolves immediately when already
 * flushed.
 */
export function whenFlushed(
  provider: HocuspocusProvider,
  timeoutMs = 10_000,
): Promise<void> {
  if (provider.unsyncedChanges === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      provider.off('unsyncedChanges', onChange);
      resolve();
    };
    const onChange = (n: number) => {
      if (n === 0) done();
    };
    const timer = setTimeout(done, timeoutMs);
    provider.on('unsyncedChanges', onChange);
  });
}

/** Connect to a document room as a headless Yjs client and wait for sync. */
export function connectDoc(
  docId: string,
  opts: ConnectOptions = {},
): Promise<DocConnection> {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();

    // Restore last-known state (offline edits + last server state) before
    // connecting, so the provider's initial sync merges it with the server.
    if (opts.persist) loadState(ydoc, docId);
    if (opts.seedDisk !== undefined) {
      applyStringToYText(ydoc.getText(CONTENT_FIELD), opts.seedDisk, DISK_ORIGIN);
    }

    // Node has no browser WebSocket; hand the provider the 'ws' polyfill
    // via an explicit websocket transport.
    const socket = new HocuspocusProviderWebsocket({
      url: SERVER_WS,
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docId,
      document: ydoc,
      token: TOKEN,
    });

    // Keep the on-disk snapshot current so a later offline session has a fresh
    // base to merge from.
    let saveTimer: NodeJS.Timeout | null = null;
    const persistObserver = () => {
      if (!opts.persist) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveState(ydoc, docId), 250);
    };
    if (opts.persist) ydoc.on('update', persistObserver);

    const timeout = setTimeout(() => {
      provider.destroy();
      reject(new Error(`timed out syncing doc ${docId}`));
    }, 15_000);

    provider.on('synced', () => {
      clearTimeout(timeout);
      if (opts.persist) saveState(ydoc, docId);
      resolve({
        ydoc,
        ytext: ydoc.getText(CONTENT_FIELD),
        provider,
        close: () => {
          if (saveTimer) clearTimeout(saveTimer);
          if (opts.persist) saveState(ydoc, docId);
          ydoc.off('update', persistObserver);
          provider.destroy();
          socket.destroy();
          ydoc.destroy();
        },
      });
    });

    provider.on('authenticationFailed', () => {
      clearTimeout(timeout);
      provider.destroy();
      reject(new Error('authentication failed (check MARKUP_TOKEN)'));
    });
  });
}
