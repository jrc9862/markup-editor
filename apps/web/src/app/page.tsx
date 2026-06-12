'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { DocMeta } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';
import UserMenu from '@/components/UserMenu';

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: DocMeta[];
}

/** Group docs into a directory tree mirroring their local paths. */
function buildTree(docs: DocMeta[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const doc of docs) {
    const parts = (doc.path ?? doc.name).split('/').filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(doc);
  }
  return root;
}

function DirNode({ name, node }: { name: string; node: TreeDir }) {
  return (
    <details open className="tree-dir">
      <summary>
        <span className="tree-icon">▸</span> {name}/
      </summary>
      <div className="tree-children">
        <TreeBody node={node} />
      </div>
    </details>
  );
}

function TreeBody({ node }: { node: TreeDir }) {
  const dirs = Array.from(node.dirs.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const files = [...node.files].sort((a, b) =>
    (a.path ?? a.name).localeCompare(b.path ?? b.name),
  );
  return (
    <>
      {dirs.map(([dirName, child]) => (
        <DirNode key={dirName} name={dirName} node={child} />
      ))}
      {files.map((doc) => (
        <Link key={doc.docId} className="tree-file" href={`/doc/${doc.docId}`}>
          <span className="tree-filename">
            {(doc.path ?? doc.name).split('/').pop()}
          </span>
          <span className="date">
            {new Date(doc.updatedAt).toLocaleString()}
          </span>
        </Link>
      ))}
    </>
  );
}

export default function HomePage() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${SERVER_HTTP}/api/docs`, {
      headers: authHeaders(),
      credentials: 'include',
    })
      .then((r) => {
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        return r.json();
      })
      .then(setDocs)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="doc-list">
      <div className="doc-list-header">
        <h1>markup</h1>
        <UserMenu />
      </div>
      <p style={{ color: 'var(--muted)' }}>
        Files appear here in the same directory structure as on disk. Open one
        from your terminal with <code>markup open path/to/file.md</code>.
      </p>
      {error && <p style={{ color: 'var(--red)' }}>Could not load docs: {error}</p>}
      {docs && docs.length === 0 && <p className="empty">No documents yet.</p>}
      {docs && docs.length > 0 && (
        <div className="tree">
          <TreeBody node={buildTree(docs)} />
        </div>
      )}
    </main>
  );
}
