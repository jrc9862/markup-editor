import { describe, it, expect } from 'vitest';
import { docEvents, extractMentions, type DocEvent } from './events.js';

describe('extractMentions', () => {
  it('pulls @handles out of free text', () => {
    expect(extractMentions('hey @ada and @bob-smith look at @ada')).toEqual([
      'ada',
      'bob-smith',
    ]);
    expect(extractMentions('no mentions here')).toEqual([]);
    // email-like text should not be treated as a mention
    expect(extractMentions('mail me at me@example.com')).toEqual([]);
  });
});

describe('docEvents bus', () => {
  it('delivers events to a doc subscriber and stops after unsubscribe', () => {
    const received: DocEvent[] = [];
    const unsub = docEvents.subscribe('doc-x', (e) => received.push(e));

    docEvents.publish({ type: 'comment', docId: 'doc-x', ts: 't1' });
    docEvents.publish({ type: 'content', docId: 'other', ts: 't2' }); // different doc
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('comment');

    unsub();
    docEvents.publish({ type: 'content', docId: 'doc-x', ts: 't3' });
    expect(received).toHaveLength(1);
  });
});
