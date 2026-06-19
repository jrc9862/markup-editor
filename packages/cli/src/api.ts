import type { CreateDocRequest, DocMeta } from '@markup/sync-core';
import { SERVER_HTTP, TOKEN } from './config.js';

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function createDoc(req: CreateDocRequest): Promise<DocMeta> {
  const res = await fetch(`${SERVER_HTTP}/api/docs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`create failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DocMeta;
}

export async function renameDoc(
  docId: string,
  fields: { name?: string; path?: string },
): Promise<DocMeta> {
  const res = await fetch(`${SERVER_HTTP}/api/docs/${docId}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    throw new Error(`rename failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DocMeta;
}

export async function getDoc(docId: string): Promise<DocMeta | null> {
  const res = await fetch(`${SERVER_HTTP}/api/docs/${docId}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`get failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as DocMeta;
}
