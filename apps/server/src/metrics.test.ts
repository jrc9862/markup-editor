import { describe, it, expect } from 'vitest';
import {
  registry,
  wsConnections,
  docsLoaded,
  docUpdates,
  persistDuration,
} from './metrics.js';

describe('metrics registry', () => {
  it('renders the markup-specific collectors', async () => {
    wsConnections.set(3);
    docsLoaded.set(2);
    docUpdates.inc();
    persistDuration.observe(0.02);

    const text = await registry.metrics();
    expect(text).toContain('markup_ws_connections 3');
    expect(text).toContain('markup_docs_loaded 2');
    expect(text).toContain('markup_doc_updates_total');
    expect(text).toContain('markup_persist_duration_seconds');
    // Default Node process metrics are registered under the markup_ prefix.
    expect(text).toContain('markup_process_cpu_user_seconds_total');
  });
});
