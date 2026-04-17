/**
 * Tests for the persistent typing indicator in delivery.ts.
 *
 * The heartbeat uses the container-owned `processing_ack` table as the
 * "agent is working" signal, with a grace period to cover container spawn
 * before the container has written its first processing row.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { setDeliveryAdapter, triggerTyping, stopTypingForSession, stopDeliveryPolls, __testing } from './delivery.js';
import type { Session } from './types.js';

const { tickTypingForSession, typingStates, constants } = __testing;

function makeSession(id = 'sess-1', agentGroupId = 'ag-1'): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function makeOutDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return db;
}

function insertProcessing(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO processing_ack VALUES (?, 'processing', datetime('now'))").run(id);
}

function clearProcessing(db: Database.Database): void {
  db.prepare('DELETE FROM processing_ack').run();
}

type SetTypingFn = (channelType: string, platformId: string, threadId: string | null) => void;
let setTypingMock: ReturnType<typeof vi.fn<SetTypingFn>>;

beforeEach(() => {
  vi.useFakeTimers();
  setTypingMock = vi.fn<SetTypingFn>();
  setDeliveryAdapter({
    deliver: async () => undefined,
    setTyping: async (channelType: string, platformId: string, threadId: string | null) => {
      setTypingMock(channelType, platformId, threadId);
    },
  });
  typingStates.clear();
});

afterEach(() => {
  vi.useRealTimers();
  typingStates.clear();
});

describe('triggerTyping', () => {
  it('fires an immediate setTyping pulse', () => {
    const sess = makeSession();
    triggerTyping(sess, 'discord', 'chan-1', null);
    expect(setTypingMock).toHaveBeenCalledTimes(1);
    expect(setTypingMock).toHaveBeenCalledWith('discord', 'chan-1', null);
  });

  it('dedupes repeat calls for the same session+channel tuple', () => {
    const sess = makeSession();
    triggerTyping(sess, 'discord', 'chan-1', null);
    triggerTyping(sess, 'discord', 'chan-1', null);
    triggerTyping(sess, 'discord', 'chan-1', null);
    // Three immediate pulses (one per call) but only one state entry.
    expect(setTypingMock).toHaveBeenCalledTimes(3);
    const entries = [...typingStates.entries()].filter(([k]) => k.startsWith('sess-1:'));
    expect(entries).toHaveLength(1);
  });

  it('tracks separate state per thread for agent-shared sessions', () => {
    const sess = makeSession();
    triggerTyping(sess, 'discord', 'chan-1', 'thread-a');
    triggerTyping(sess, 'discord', 'chan-1', 'thread-b');
    const keys = [...typingStates.keys()].filter((k) => k.startsWith('sess-1:'));
    expect(keys).toHaveLength(2);
  });
});

describe('tickTypingForSession', () => {
  it('pulses while processing_ack has a processing row', () => {
    const sess = makeSession();
    const outDb = makeOutDb();
    insertProcessing(outDb, 'msg-1');

    triggerTyping(sess, 'discord', 'chan-1', null);
    setTypingMock.mockClear();

    // Advance past pulse interval, then tick.
    vi.advanceTimersByTime(constants.TYPING_INTERVAL_MS + 100);
    tickTypingForSession(sess, outDb);

    expect(setTypingMock).toHaveBeenCalledTimes(1);
    expect(typingStates.size).toBe(1);
  });

  it('respects TYPING_INTERVAL_MS — does not pulse twice in a row within the interval', () => {
    const sess = makeSession();
    const outDb = makeOutDb();
    insertProcessing(outDb, 'msg-1');

    triggerTyping(sess, 'discord', 'chan-1', null);
    setTypingMock.mockClear();

    vi.advanceTimersByTime(1_000);
    tickTypingForSession(sess, outDb); // too soon
    expect(setTypingMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(constants.TYPING_INTERVAL_MS);
    tickTypingForSession(sess, outDb);
    expect(setTypingMock).toHaveBeenCalledTimes(1);
  });

  it('keeps pulsing during grace period even with no processing_ack rows', () => {
    const sess = makeSession();
    const outDb = makeOutDb(); // empty — container not yet writing

    triggerTyping(sess, 'discord', 'chan-1', null);
    setTypingMock.mockClear();

    vi.advanceTimersByTime(constants.TYPING_INTERVAL_MS + 100);
    tickTypingForSession(sess, outDb);

    expect(setTypingMock).toHaveBeenCalledTimes(1);
    expect(typingStates.size).toBe(1);
  });

  it('stops after grace period if processing_ack is empty (agent idle)', () => {
    const sess = makeSession();
    const outDb = makeOutDb();

    triggerTyping(sess, 'discord', 'chan-1', null);
    setTypingMock.mockClear();

    vi.advanceTimersByTime(constants.TYPING_GRACE_MS + 100);
    tickTypingForSession(sess, outDb);

    expect(setTypingMock).not.toHaveBeenCalled();
    expect(typingStates.size).toBe(0);
  });

  it('stops once processing_ack clears after the agent finishes', () => {
    const sess = makeSession();
    const outDb = makeOutDb();
    insertProcessing(outDb, 'msg-1');

    triggerTyping(sess, 'discord', 'chan-1', null);

    // Still processing after grace window.
    vi.advanceTimersByTime(constants.TYPING_GRACE_MS + 100);
    tickTypingForSession(sess, outDb);
    expect(typingStates.size).toBe(1);

    // Agent finishes — processing_ack cleared (or transitioned to completed).
    clearProcessing(outDb);
    vi.advanceTimersByTime(constants.TYPING_INTERVAL_MS + 100);
    setTypingMock.mockClear();
    tickTypingForSession(sess, outDb);

    expect(setTypingMock).not.toHaveBeenCalled();
    expect(typingStates.size).toBe(0);
  });

  it('stops after MAX_TYPING_DURATION_MS as a safety cap', () => {
    const sess = makeSession();
    const outDb = makeOutDb();
    insertProcessing(outDb, 'msg-1'); // stuck "processing" forever

    triggerTyping(sess, 'discord', 'chan-1', null);

    vi.advanceTimersByTime(constants.TYPING_MAX_DURATION_MS + 1_000);
    setTypingMock.mockClear();
    tickTypingForSession(sess, outDb);

    expect(setTypingMock).not.toHaveBeenCalled();
    expect(typingStates.size).toBe(0);
  });
});

describe('stopTypingForSession', () => {
  it('removes all typing states for the given session, leaves other sessions intact', () => {
    const a = makeSession('sess-a');
    const b = makeSession('sess-b');
    triggerTyping(a, 'discord', 'chan-1', null);
    triggerTyping(a, 'discord', 'chan-1', 'thread-x');
    triggerTyping(b, 'discord', 'chan-2', null);

    stopTypingForSession('sess-a');

    const keys = [...typingStates.keys()];
    expect(keys.some((k) => k.startsWith('sess-a:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('sess-b:'))).toBe(true);
  });
});

describe('stopDeliveryPolls', () => {
  it('clears all typing states', () => {
    const a = makeSession('sess-a');
    const b = makeSession('sess-b');
    triggerTyping(a, 'discord', 'chan-1', null);
    triggerTyping(b, 'discord', 'chan-2', null);

    stopDeliveryPolls();
    expect(typingStates.size).toBe(0);
  });
});
