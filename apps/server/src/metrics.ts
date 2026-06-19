import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics (Phase 2 observability). One registry holds default Node
 * process metrics plus the markup-specific collectors below; the server
 * exposes it at `GET /metrics`. Collectors are mutated from the Hocuspocus
 * lifecycle hooks and the REST timing middleware in index.ts.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'markup_' });

/** Live WebSocket (Yjs sync) connections. */
export const wsConnections = new Gauge({
  name: 'markup_ws_connections',
  help: 'Open WebSocket sync connections',
  registers: [registry],
});

/** Documents currently loaded in memory by Hocuspocus. */
export const docsLoaded = new Gauge({
  name: 'markup_docs_loaded',
  help: 'Documents currently loaded in memory',
  registers: [registry],
});

/** Total Y.Doc changes observed (proxy for edit throughput). */
export const docUpdates = new Counter({
  name: 'markup_doc_updates_total',
  help: 'Total document change events',
  registers: [registry],
});

/** Persistence latency: time to snapshot/store a document. */
export const persistDuration = new Histogram({
  name: 'markup_persist_duration_seconds',
  help: 'Duration of onStoreDocument persistence',
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

/** Version snapshots dropped by the retention policy (Phase 2 history pruning). */
export const versionsPruned = new Counter({
  name: 'markup_versions_pruned_total',
  help: 'doc_versions snapshots removed by the retention policy',
  registers: [registry],
});

/** REST request latency, labelled by method/route/status. */
export const httpDuration = new Histogram({
  name: 'markup_http_request_duration_seconds',
  help: 'REST request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});
