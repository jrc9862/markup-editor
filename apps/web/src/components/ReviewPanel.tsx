'use client';

import { useState } from 'react';
import type { SuggestionData } from '@markup/sync-core';
import { SERVER_HTTP, authHeaders } from '@/lib/config';

type Disposition = 'accept' | 'reject' | undefined;

/**
 * PR-style batch review of suggestions (roadmap #3): disposition every open
 * suggestion (accept / reject / leave) and apply the whole batch in one call,
 * the way a reviewer dispositions a pull request's changes at once.
 */
export default function ReviewPanel({
  docId,
  open,
  onClose,
  onApplied,
}: {
  docId: string;
  open: SuggestionData[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [picks, setPicks] = useState<Record<string, Disposition>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const set = (id: string, d: Disposition) =>
    setPicks((p) => ({ ...p, [id]: p[id] === d ? undefined : d }));

  const setAll = (d: Disposition) =>
    setPicks(Object.fromEntries(open.map((s) => [s.id, d])));

  const accept = open.filter((s) => picks[s.id] === 'accept').map((s) => s.id);
  const reject = open.filter((s) => picks[s.id] === 'reject').map((s) => s.id);

  const apply = async () => {
    if (accept.length === 0 && reject.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(
        `${SERVER_HTTP}/api/docs/${docId}/suggestions/review`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ accept, reject }),
        },
      );
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote(json.error ?? `error ${r.status}`);
        return;
      }
      setNote(`Accepted ${json.accepted}, rejected ${json.rejected}`);
      setPicks({});
      onApplied();
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="history-panel">
      <div className="history-title">
        <strong>Review suggestions</strong>
        <button className="ghost-btn" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="history-body">
        {open.length === 0 && <p className="empty">No open suggestions.</p>}
        {open.length > 0 && (
          <div className="review-bulk">
            <button className="ghost-btn" onClick={() => setAll('accept')}>
              Accept all
            </button>
            <button className="ghost-btn" onClick={() => setAll('reject')}>
              Reject all
            </button>
            <button className="ghost-btn" onClick={() => setAll(undefined)}>
              Clear
            </button>
          </div>
        )}
        {open.map((s) => (
          <div className="card review-item" key={s.id}>
            <div className="review-author mono">{s.author}</div>
            <div className="review-diff">
              <del>{s.original || '∅'}</del>
              <ins>{s.proposed || '∅'}</ins>
            </div>
            <div className="review-actions">
              <button
                className={`ghost-btn ${picks[s.id] === 'accept' ? 'pick-accept' : ''}`}
                onClick={() => set(s.id, 'accept')}
              >
                Accept
              </button>
              <button
                className={`ghost-btn ${picks[s.id] === 'reject' ? 'pick-reject' : ''}`}
                onClick={() => set(s.id, 'reject')}
              >
                Reject
              </button>
            </div>
          </div>
        ))}
        {open.length > 0 && (
          <button
            className="primary-btn"
            disabled={busy || (accept.length === 0 && reject.length === 0)}
            onClick={apply}
          >
            Apply review ({accept.length}✓ {reject.length}✕)
          </button>
        )}
        {note && <div className="find-status">{note}</div>}
      </div>
    </aside>
  );
}
