'use client';

import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { applyEdits, findReplaceEdits } from '@markup/sync-core';

/**
 * Batch find/replace (roadmap #1): replaces every match across the document
 * in one Yjs transaction, so it lands and undoes as a single step and still
 * merges with concurrent peers. Plain substring by default; opt into regex
 * (with `$n` backrefs in the replacement).
 */
export default function FindReplacePanel({
  ytext,
  onClose,
}: {
  ytext: Y.Text;
  onClose: () => void;
}) {
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const matchCount = useMemo(() => {
    if (!find) return 0;
    try {
      return findReplaceEdits(ytext.toString(), find, replace, {
        regex,
        caseSensitive,
      }).length;
    } catch {
      return -1; // invalid regex
    }
  }, [find, replace, regex, caseSensitive, ytext]);

  const replaceAll = () => {
    try {
      const edits = findReplaceEdits(ytext.toString(), find, replace, {
        regex,
        caseSensitive,
      });
      const n = applyEdits(ytext, edits, 'find-replace');
      setStatus(n === 0 ? 'No matches' : `Replaced ${n}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'invalid pattern');
    }
  };

  return (
    <div className="find-replace">
      <div className="find-replace-head">
        <strong>Find &amp; replace</strong>
        <button className="ghost-btn" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <input
        className="find-input"
        placeholder="Find"
        value={find}
        onChange={(e) => {
          setFind(e.target.value);
          setStatus(null);
        }}
        autoFocus
      />
      <input
        className="find-input"
        placeholder="Replace with"
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
      />
      <div className="find-opts">
        <label>
          <input
            type="checkbox"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />{' '}
          .* regex
        </label>
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />{' '}
          Aa case
        </label>
      </div>
      <div className="find-actions">
        <span className="find-count">
          {matchCount < 0 ? 'invalid pattern' : `${matchCount} match(es)`}
        </span>
        <button
          className="primary-btn"
          onClick={replaceAll}
          disabled={!find || matchCount <= 0}
        >
          Replace all
        </button>
      </div>
      {status && <div className="find-status">{status}</div>}
    </div>
  );
}
