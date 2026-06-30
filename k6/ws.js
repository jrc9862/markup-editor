// WebSocket capacity load test for the Markup sync server.
//
// What it stresses: the expensive per-connection path — TLS/WS upgrade,
// Hocuspocus `onAuthenticate` (principal resolution + ACL + per-user
// connection cap), document load, and holding many concurrent live
// connections (the real 10k-user scaling concern). Each VU connects to a doc,
// authenticates, runs sync-step-1, then holds the connection open like a
// present user before disconnecting.
//
// Edit *throughput* is exercised separately by rest.js (generating valid Yjs
// updates in raw k6 is impractical); together they cover the two axes.
//
// Run:  k6 run k6/ws.js
// Tune: BASE_WS, BASE_REST, TOKEN, VUS, DURATION, HOLD_MS, DOC_POOL
//   (defaults target ~2x a modest expected peak; see k6/README.md)

import { WebSocket } from 'k6/experimental/websockets';
// setTimeout is a k6 global (the experimental/timers module graduated).
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { authMessage, syncStep1, classify } from './lib/hocuspocus.js';

const BASE_WS = __ENV.BASE_WS || 'ws://localhost:4000';
const BASE_REST = __ENV.BASE_REST || 'http://localhost:4000';
const TOKEN = __ENV.TOKEN || 'dev-token';
const VUS = Number(__ENV.VUS || 200);
const DURATION = __ENV.DURATION || '1m';
const HOLD_MS = Number(__ENV.HOLD_MS || 5000);
const DOC_POOL = Number(__ENV.DOC_POOL || 25);

const authOk = new Counter('ws_authenticated');
const authDenied = new Counter('ws_denied');
const syncRecv = new Counter('ws_first_sync');
const wsErrors = new Counter('ws_errors');
const connectTime = new Trend('ws_connect_ms', true);
const authTime = new Trend('ws_auth_ms', true);

export const options = {
  scenarios: {
    presence: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulStop: '10s',
    },
  },
  thresholds: {
    ws_denied: ['count==0'],
    ws_errors: ['count==0'],
    ws_connect_ms: ['p(95)<1000'],
    ws_auth_ms: ['p(95)<1500'],
    checks: ['rate>0.99'],
  },
};

// Seed a pool of docs once; VUs spread their connections across them so we're
// not all hammering a single room (and not creating 10k rooms either).
export function setup() {
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const docIds = [];
  for (let i = 0; i < DOC_POOL; i++) {
    const res = http.post(
      `${BASE_REST}/api/docs`,
      JSON.stringify({ name: `loadtest-ws-${Date.now()}-${i}`, content: `# Load test doc ${i}\n` }),
      { headers },
    );
    if (res.status !== 201) fail(`setup: could not create doc (status ${res.status}): ${res.body}`);
    docIds.push(JSON.parse(res.body).docId);
  }
  return { docIds };
}

export default function (data) {
  const docId = data.docIds[(__VU + __ITER) % data.docIds.length];
  const url = `${BASE_WS}/${docId}`;
  const t0 = Date.now();
  let tOpen = 0;
  let done = false;

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    tOpen = Date.now();
    connectTime.add(tOpen - t0);
    ws.send(authMessage(docId, TOKEN));
    ws.send(syncStep1(docId));
  };

  ws.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const kind = classify(e.data);
    if (kind === 'authenticated') {
      authOk.add(1);
      authTime.add(Date.now() - tOpen);
    } else if (kind === 'denied') {
      authDenied.add(1);
      check(false, { 'ws not denied': () => false });
      ws.close();
    } else if (kind === 'sync') {
      if (!done) {
        done = true;
        syncRecv.add(1);
        check(true, { 'received sync reply': () => true });
        // Hold the connection open like a present user, then leave.
        setTimeout(() => ws.close(), HOLD_MS);
      }
    }
  };

  ws.onerror = (e) => {
    wsErrors.add(1);
    check(false, { 'ws no error': () => false });
    // eslint-disable-next-line no-console
    console.error(`ws error on ${docId}: ${e && e.error}`);
  };
}
