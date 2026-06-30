// REST agent-surface throughput load test for the Markup server.
//
// What it stresses: the Express + `openDirectConnection` write path that every
// agent action funnels through — snapshot reads, transactional multi-edits,
// comment creation, and doc listing. These all touch the live Y.Doc on the
// handling node, so this is the read/write-throughput counterpart to ws.js's
// connection-capacity test.
//
// Run:  k6 run k6/rest.js
// Tune: BASE_REST, TOKEN, VUS, DURATION, DOC_POOL (see k6/README.md)

import http from 'k6/http';
import { check, fail, group } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_REST = __ENV.BASE_REST || 'http://localhost:4000';
const TOKEN = __ENV.TOKEN || 'dev-token';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '1m';
const DOC_POOL = Number(__ENV.DOC_POOL || 25);

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const editLatency = new Trend('rest_edit_ms', true);
const snapshotLatency = new Trend('rest_snapshot_ms', true);

export const options = {
  scenarios: {
    agents: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    rest_edit_ms: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const docIds = [];
  for (let i = 0; i < DOC_POOL; i++) {
    const res = http.post(
      `${BASE_REST}/api/docs`,
      JSON.stringify({
        name: `loadtest-rest-${Date.now()}-${i}`,
        content: `# Load doc ${i}\n\nThe quick brown fox jumps over the lazy dog.\n`,
      }),
      { headers },
    );
    if (res.status !== 201) fail(`setup: could not create doc (status ${res.status}): ${res.body}`);
    docIds.push(JSON.parse(res.body).docId);
  }
  return { docIds };
}

export default function (data) {
  const docId = data.docIds[(__VU + __ITER) % data.docIds.length];

  group('read snapshot', () => {
    const res = http.get(`${BASE_REST}/api/docs/${docId}/snapshot`, { headers });
    snapshotLatency.add(res.timings.duration);
    check(res, { 'snapshot 200': (r) => r.status === 200 });
  });

  group('multi-edit (find/replace)', () => {
    // Flip a word back and forth so repeated runs stay self-consistent.
    const [find, replace] = __ITER % 2 === 0 ? ['quick', 'swift'] : ['swift', 'quick'];
    const res = http.post(
      `${BASE_REST}/api/docs/${docId}/edits`,
      JSON.stringify({ find, replace }),
      { headers },
    );
    editLatency.add(res.timings.duration);
    check(res, { 'edit 200': (r) => r.status === 200 });
  });

  group('comment (anchorText)', () => {
    const res = http.post(
      `${BASE_REST}/api/docs/${docId}/comments`,
      // `author` is required for legacy/shared-token principals (signed-in
      // humans are stamped server-side instead).
      JSON.stringify({ anchorText: 'fox', text: `load comment ${__VU}/${__ITER}`, author: 'loadbot' }),
      { headers },
    );
    // 201 created, or 400 if the anchor text isn't present in this doc revision.
    check(res, { 'comment 201/400': (r) => r.status === 201 || r.status === 400 });
  });

  group('list docs', () => {
    const res = http.get(`${BASE_REST}/api/docs`, { headers });
    check(res, { 'list 200': (r) => r.status === 200 });
  });
}
