'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormatTarget } from './format';

/**
 * Formatting toolbar for non-technical edits. Buttons delegate to the active
 * editor mode's FormatTarget, so the same toolbar drives both CodeMirror
 * (markdown text manipulation) and TipTap (rich commands).
 */
export default function Toolbar({
  format,
  canAnnotate,
  suggesting,
  suggestingAvailable,
  onSuggestingChange,
  onComment,
  onSuggest,
}: {
  format: FormatTarget | null;
  canAnnotate: boolean;
  /** Realtime suggestion mode state (source mode only for now). */
  suggesting: boolean;
  suggestingAvailable: boolean;
  onSuggestingChange: (v: boolean) => void;
  onComment: () => void;
  onSuggest: () => void;
}) {
  const [tableOpen, setTableOpen] = useState(false);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tableOpen) return;
    const close = (e: MouseEvent) => {
      if (!tableRef.current?.contains(e.target as Node)) setTableOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [tableOpen]);

  const f = format;
  const dis = !f;

  return (
    <div className="toolbar">
      <select
        className="tb-select"
        disabled={dis}
        value=""
        onChange={(e) => {
          if (e.target.value !== '') {
            f?.heading(Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6);
          }
        }}
        title="Heading level"
      >
        <option value="" disabled>
          Style
        </option>
        <option value="0">Paragraph</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
        <option value="4">Heading 4</option>
      </select>

      <span className="tb-sep" />

      <button className="tb-btn" disabled={dis} title="Bold" onClick={() => f?.bold()}>
        <b>B</b>
      </button>
      <button className="tb-btn" disabled={dis} title="Italic" onClick={() => f?.italic()}>
        <i>I</i>
      </button>
      <button
        className="tb-btn"
        disabled={dis}
        title="Underline (inline HTML in markdown)"
        onClick={() => f?.underline()}
      >
        <u>U</u>
      </button>

      <span className="tb-sep" />

      <button
        className="tb-btn mono"
        disabled={dis}
        title="Inline code"
        onClick={() => f?.inlineCode()}
      >
        {'<>'}
      </button>
      <button
        className="tb-btn mono"
        disabled={dis}
        title="Code block"
        onClick={() => f?.codeBlock()}
      >
        {'```'}
      </button>
      <button className="tb-btn" disabled={dis} title="Quote" onClick={() => f?.quote()}>
        ❝
      </button>
      <button
        className="tb-btn"
        disabled={dis}
        title="Bullet list"
        onClick={() => f?.bulletList()}
      >
        ☰
      </button>
      <button
        className="tb-btn"
        disabled={dis}
        title="Horizontal rule"
        onClick={() => f?.horizontalRule()}
      >
        —
      </button>

      <div className="tb-table-wrap" ref={tableRef}>
        <button
          className="tb-btn"
          disabled={dis}
          title="Insert table"
          onClick={() => setTableOpen((v) => !v)}
        >
          ⊞
        </button>
        {tableOpen && (
          <div className="tb-popover">
            <label>
              rows
              <input
                type="number"
                min={1}
                max={20}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </label>
            <label>
              cols
              <input
                type="number"
                min={1}
                max={10}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
              />
            </label>
            <button
              className="primary-btn"
              onClick={() => {
                f?.insertTable(rows, cols);
                setTableOpen(false);
              }}
            >
              Insert
            </button>
          </div>
        )}
      </div>

      <span className="tb-sep" />

      <button
        className="tb-btn wide"
        disabled={!canAnnotate}
        title="Comment on the selected text"
        onClick={onComment}
      >
        + Comment
      </button>
      <button
        className="tb-btn wide"
        disabled={!canAnnotate}
        title="Suggest a change to the selected text"
        onClick={onSuggest}
      >
        ± Suggest
      </button>

      <span className="tb-spacer" />

      <div
        className="edit-mode-toggle"
        title={
          suggestingAvailable
            ? 'Suggesting: your keystrokes become suggestions others can accept or reject'
            : 'Suggesting mode is available in source mode'
        }
      >
        <button
          className={!suggesting ? 'active' : ''}
          disabled={!suggestingAvailable}
          onClick={() => onSuggestingChange(false)}
        >
          ✎ Editing
        </button>
        <button
          className={suggesting ? 'active suggesting' : ''}
          disabled={!suggestingAvailable}
          onClick={() => onSuggestingChange(true)}
        >
          ± Suggesting
        </button>
      </div>
    </div>
  );
}
