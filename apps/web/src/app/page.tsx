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

type RenameFn = (doc: DocMeta) => void;

function DirNode({
  name,
  node,
  onRename,
}: {
  name: string;
  node: TreeDir;
  onRename: RenameFn;
}) {
  return (
    <details open className="tree-dir">
      <summary>
        <span className="tree-icon">▸</span> {name}/
      </summary>
      <div className="tree-children">
        <TreeBody node={node} onRename={onRename} />
      </div>
    </details>
  );
}

function TreeBody({ node, onRename }: { node: TreeDir; onRename: RenameFn }) {
  const dirs = Array.from(node.dirs.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const files = [...node.files].sort((a, b) =>
    (a.path ?? a.name).localeCompare(b.path ?? b.name),
  );
  return (
    <>
      {dirs.map(([dirName, child]) => (
        <DirNode key={dirName} name={dirName} node={child} onRename={onRename} />
      ))}
      {files.map((doc) => (
        <div key={doc.docId} className="tree-file-row">
          <Link className="tree-file" href={`/doc/${doc.docId}`}>
            <span className="tree-filename">
              {(doc.path ?? doc.name).split('/').pop()}
            </span>
            <span className="date">
              {new Date(doc.updatedAt).toLocaleString()}
            </span>
          </Link>
          <button
            className="tree-rename"
            title="Rename"
            onClick={() => onRename(doc)}
          >
            ✎
          </button>
        </div>
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

  const onRename = (doc: DocMeta) => {
    const current = (doc.path ?? doc.name).split('/').pop() ?? doc.name;
    const next = window.prompt('Rename document', current);
    if (!next || !next.trim() || next === current) return;
    const name = next.trim();
    const segs = (doc.path ?? doc.name).split('/');
    segs[segs.length - 1] = name;
    fetch(`${SERVER_HTTP}/api/docs/${doc.docId}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, path: segs.join('/') }),
    })
      .then(async (r) => {
        if (!r.ok) return;
        const updated = (await r.json()) as DocMeta;
        setDocs(
          (prev) =>
            prev?.map((d) => (d.docId === updated.docId ? updated : d)) ?? prev,
        );
      })
      .catch(() => {});
  };

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
          <TreeBody node={buildTree(docs)} onRename={onRename} />
        </div>
      )}
    </main>
  );
}
