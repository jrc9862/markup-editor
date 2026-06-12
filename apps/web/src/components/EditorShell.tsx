'use client';

import dynamic from 'next/dynamic';

// The editor stack (Yjs, CodeMirror, TipTap) is browser-only.
const Editor = dynamic(() => import('./Editor'), { ssr: false });

export default function EditorShell({ docId }: { docId: string }) {
  return <Editor docId={docId} />;
}
