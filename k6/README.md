# Load testing (k6)

Two [k6](https://k6.io) scenarios that together cover the two scaling axes for
a ~10k-user deployment:

| Script | Stresses | Key metric |
|--------|----------|------------|
| `ws.js` | Concurrent live connections: WS upgrade + Hocuspocus `onAuthenticate` (principal + ACL + per-user conn cap) + doc load + holding presence | `ws_connect_ms`, `ws_auth_ms`, `ws_authenticated` |
| `rest.js` | Agent-surface read/write throughput: snapshot reads, transactional `/edits`, comments, doc list | `rest_edit_ms`, `http_req_duration` |

WS connection *capacity* and edit *throughput* are split deliberately:
generating valid Yjs binary updates in raw k6 is impractical, so `ws.js` opens,
authenticates, runs sync-step-1, and holds the connection (the expensive part),
while `rest.js` drives writes through the REST path. `lib/hocuspocus.js`
re-implements just enough of the Hocuspocus wire framing
(`varString(doc) + varUint(type) + payload`) to authenticate and sync.

## Run locally

Start a server (SQLite + legacy token is fine for load shape):

```bash
MARKUP_RATE_MAX=0 npm run dev:server      # disable rate limiting so the LB/app is the bottleneck
```

Then, with [k6 installed](https://grafana.com/docs/k6/latest/set-up/install-k6/):

```bash
k6 run k6/rest.js
k6 run k6/ws.js
```

## Tuning (env vars)

| Var | ws.js | rest.js | Default | Meaning |
|-----|:---:|:---:|---------|---------|
| `BASE_WS` | ✓ | | `ws://localhost:4000` | sync server WS origin |
| `BASE_REST` | ✓ | ✓ | `http://localhost:4000` | REST origin (also used by ws.js setup to seed docs) |
| `TOKEN` | ✓ | ✓ | `dev-token` | bearer token (legacy shared, or an `mkp_` write token) |
| `VUS` | ✓ | ✓ | 200 / 50 | peak virtual users |
| `DURATION` | ✓ | ✓ | `1m` | hold time at peak |
| `HOLD_MS` | ✓ | | `5000` | how long each WS connection stays open |
| `DOC_POOL` | ✓ | ✓ | `25` | distinct docs VUs spread across |

Pick `VUS` at **~2× expected peak**. For 10k concurrent editors that means
running `ws.js` distributed (multiple k6 instances / a cluster) since one
process won't sustain 20k sockets; the scenario is written so N processes each
at `VUS=2000` compose cleanly.

## Thresholds

Both scripts `exit 1` if thresholds are breached (so CI fails on regression):
no auth denials or WS errors, p95 connect < 1s / auth < 1.5s, p95 REST
duration < 800ms, edit p95 < 1s, <1% HTTP failures. Adjust in each file's
`options.thresholds` as the deployment's SLOs firm up.

## CI

`.github/workflows/loadtest.yml` runs this manually (`workflow_dispatch`) with
`scenario` (rest/ws/both), `vus`, and `duration` inputs — it boots the built
server against the workflow's Postgres service and runs the chosen scripts. It
is intentionally **not** on push/PR (load tests are slow and noisy); trigger it
from the Actions tab before a release or after a scaling change.
