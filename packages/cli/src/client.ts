import * as Y from 'yjs';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import WebSocket from 'ws';
import { CONTENT_FIELD } from '@markup/sync-core';
import { SERVER_WS, TOKEN } from './config.js';

export interface DocConnection {
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  close: () => void;
}

/** Connect to a document room as a headless Yjs client and wait for sync. */
export function connectDoc(docId: string): Promise<DocConnection> {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();
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

    const timeout = setTimeout(() => {
      provider.destroy();
      reject(new Error(`timed out syncing doc ${docId}`));
    }, 15_000);

    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve({
        ydoc,
        ytext: ydoc.getText(CONTENT_FIELD),
        provider,
        close: () => {
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
