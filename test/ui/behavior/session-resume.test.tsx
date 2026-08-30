/**
 * Session-resume seeding (kc --continue/--resume): a session restored before
 * the UI started must appear in the transcript, and the seeded messages must
 * SURVIVE subsequent streaming flushes — the useStreamingEvents setMessages
 * wrapper keeps messagesRef in sync, so a delta flush cannot clobber the
 * externally seeded state (this also protects /session load).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('session resume seeding (behavior)', () => {
  it('seeds a restored session into the transcript and keeps it across streaming flushes', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({
      width: 100,
      height: 30,
      engine,
      resumedSession: {
        sessionId: 'resumed-session',
        turnCount: 3,
        messages: [
          { id: 'u1', role: 'user', content: 'earlier question', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: 'earlier answer', timestamp: 2 },
        ],
      },
    });

    // The restored conversation is visible right after startup.
    await h.waitForText('earlier question', 5000);
    await h.waitForText('earlier answer', 5000);

    // A new turn streams normally on top of the seeded transcript, and the
    // seeded messages are not wiped by the delta flushes.
    engine.scriptEvents([{ type: 'text_delta', text: 'new reply' }]);
    await h.type('follow-up');
    await h.press(KEYS.enter);
    await h.waitForText('new reply', 5000);

    expect(h.plainFrame()).toContain('earlier answer');
    expect(h.plainFrame()).toContain('earlier question');
    expect(h.plainFrame()).toContain('new reply');
    expect(engine.submittedMessages).toEqual(['follow-up']);
  });

  it('renders an empty transcript when no session was resumed', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.waitForText('No messages yet', 5000);
  });
});
