import { describe, it, expect } from 'vitest';

import {
  createInitialAppServerTurnState,
  reduceAppServerTurnState,
  isAppServerTurnFinished,
  getAppServerTurnResult,
  type AppServerTurnEvent,
} from './app-server-state.js';

describe('AppServerTurnState', () => {
  it('creates initial state with pending status', () => {
    const state = createInitialAppServerTurnState();
    expect(state.status).toBe('pending');
    expect(state.finalAnswer).toBeNull();
    expect(state.latestAgentMessage).toBeNull();
    expect(state.errorMessage).toBeNull();
    expect(state.compactionCompleted).toBe(false);
    expect(isAppServerTurnFinished(state)).toBe(false);
  });

  it('transitions to inProgress on turn/started', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'turn/started',
      params: { turn: { id: 'turn-1', status: 'inProgress' } },
    });
    expect(state.status).toBe('inProgress');
    expect(state.turnId).toBe('turn-1');
    expect(isAppServerTurnFinished(state)).toBe(false);
  });

  it('captures final_answer from item/completed', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', text: 'Hello world', phase: 'final_answer' },
      },
    });
    expect(state.finalAnswer).toBe('Hello world');
    expect(state.latestAgentMessage).toBe('Hello world');
    expect(getAppServerTurnResult(state)).toBe('Hello world');
  });

  it('captures commentary without setting finalAnswer', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', text: 'Thinking...', phase: 'commentary' },
      },
    });
    expect(state.latestAgentMessage).toBe('Thinking...');
    expect(state.finalAnswer).toBeNull();
  });

  it('ignores empty text in agentMessage', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', text: '   ', phase: 'final_answer' },
      },
    });
    expect(state.finalAnswer).toBeNull();
  });

  it('handles contextCompaction item', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: { item: { type: 'contextCompaction' } },
    });
    expect(state.compactionCompleted).toBe(true);
  });

  it('captures error with HTTP status', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'error',
      params: {
        error: {
          message: 'Rate limited',
          codexErrorInfo: { httpStatusCode: 429, type: 'rate_limit' },
        },
      },
    });
    expect(state.errorMessage).toBe('Rate limited (HTTP 429)');
  });

  it('captures error without HTTP status', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'error',
      params: { error: { message: 'Something broke' } },
    });
    expect(state.errorMessage).toBe('Something broke');
  });

  it('uses default error message for empty error', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'error',
      params: { error: { message: '' } },
    });
    expect(state.errorMessage).toBe('Codex app-server turn failed.');
  });

  it('transitions to completed on turn/completed', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'turn/started',
      params: { turn: { id: 'turn-1' } },
    });
    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });
    expect(state.status).toBe('completed');
    expect(isAppServerTurnFinished(state)).toBe(true);
  });

  it('transitions to failed on turn/completed with failed status', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-1', status: 'failed', error: { message: 'model error' } },
      },
    });
    expect(state.status).toBe('failed');
    expect(state.errorMessage).toBe('model error');
    expect(isAppServerTurnFinished(state)).toBe(true);
  });

  it('transitions to interrupted on turn/completed', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'interrupted' } },
    });
    expect(state.status).toBe('interrupted');
    expect(isAppServerTurnFinished(state)).toBe(true);
  });

  it('handles string error in turn/completed', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'failed', error: 'plain string error' } },
    });
    expect(state.errorMessage).toBe('plain string error');
  });

  it('preserves existing errorMessage if turn error is null', () => {
    let state = createInitialAppServerTurnState();
    state = reduceAppServerTurnState(state, {
      method: 'error',
      params: { error: { message: 'earlier error' } },
    });
    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });
    expect(state.errorMessage).toBe('earlier error');
  });

  it('returns state unchanged for unknown events', () => {
    const state = createInitialAppServerTurnState();
    const next = reduceAppServerTurnState(state, {
      method: 'unknown/event',
    } as unknown as AppServerTurnEvent);
    expect(next).toBe(state);
  });

  it('handles full turn lifecycle', () => {
    let state = createInitialAppServerTurnState();

    state = reduceAppServerTurnState(state, {
      method: 'turn/started',
      params: { turn: { id: 'turn-42' } },
    });
    expect(state.status).toBe('inProgress');

    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', text: 'Working on it...', phase: 'commentary' },
      },
    });
    expect(state.latestAgentMessage).toBe('Working on it...');

    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', text: 'Here is the answer', phase: 'final_answer' },
      },
    });
    expect(state.finalAnswer).toBe('Here is the answer');

    state = reduceAppServerTurnState(state, {
      method: 'turn/completed',
      params: { turn: { id: 'turn-42', status: 'completed' } },
    });
    expect(state.status).toBe('completed');
    expect(isAppServerTurnFinished(state)).toBe(true);
    expect(getAppServerTurnResult(state)).toBe('Here is the answer');
  });
});
