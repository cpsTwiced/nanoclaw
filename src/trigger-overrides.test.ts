import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadTriggerOverrides,
  reloadTriggerOverrides,
  saveTriggerOverrides,
} from './trigger-overrides.js';

let tmpDir: string;
let cfgPath: string;

function writeConfig(data: unknown): void {
  fs.writeFileSync(cfgPath, JSON.stringify(data));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-overrides-'));
  cfgPath = path.join(tmpDir, 'trigger-overrides.json');
  reloadTriggerOverrides();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  reloadTriggerOverrides();
});

describe('loadTriggerOverrides', () => {
  it('returns empty config when file does not exist', () => {
    const cfg = loadTriggerOverrides(path.join(tmpDir, 'nonexistent.json'));
    expect(cfg).toEqual({ chats: {} });
  });

  it('loads valid config', () => {
    writeConfig({
      chats: {
        'dc:123': { exemptSenders: ['alice', 'bob'] },
      },
    });
    const cfg = loadTriggerOverrides(cfgPath);
    expect(cfg.chats['dc:123'].exemptSenders).toEqual(['alice', 'bob']);
  });

  it('returns empty config for invalid JSON', () => {
    fs.writeFileSync(cfgPath, 'not json{{{');
    const cfg = loadTriggerOverrides(cfgPath);
    expect(cfg).toEqual({ chats: {} });
  });

  it('skips invalid entries', () => {
    writeConfig({
      chats: {
        'dc:123': { exemptSenders: [123, true] },
        'dc:456': { exemptSenders: ['valid'] },
      },
    });
    const cfg = loadTriggerOverrides(cfgPath);
    expect(cfg.chats['dc:123']).toBeUndefined();
    expect(cfg.chats['dc:456'].exemptSenders).toEqual(['valid']);
  });

  it('handles empty chats object', () => {
    writeConfig({ chats: {} });
    const cfg = loadTriggerOverrides(cfgPath);
    expect(cfg).toEqual({ chats: {} });
  });

  it('handles missing chats key', () => {
    writeConfig({});
    const cfg = loadTriggerOverrides(cfgPath);
    expect(cfg).toEqual({ chats: {} });
  });
});

describe('saveTriggerOverrides', () => {
  it('creates config directory if missing', () => {
    const nestedPath = path.join(tmpDir, 'a', 'b', 'config.json');
    saveTriggerOverrides({ chats: {} }, nestedPath);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('round-trips correctly', () => {
    const config = {
      chats: {
        'dc:123': { exemptSenders: ['alice', 'bob'] },
      },
    };
    saveTriggerOverrides(config, cfgPath);
    const loaded = loadTriggerOverrides(cfgPath);
    expect(loaded).toEqual(config);
  });
});

describe('add/remove/list via save+load', () => {
  it('adds a sender to a new chat', () => {
    const config = { chats: {} as Record<string, { exemptSenders: string[] }> };
    config.chats['dc:123'] = { exemptSenders: ['alice'] };
    saveTriggerOverrides(config, cfgPath);
    const reloaded = loadTriggerOverrides(cfgPath);
    expect(reloaded.chats['dc:123'].exemptSenders).toEqual(['alice']);
  });

  it('does not duplicate existing sender', () => {
    const config = {
      chats: { 'dc:123': { exemptSenders: ['alice'] } },
    };
    saveTriggerOverrides(config, cfgPath);
    const loaded = loadTriggerOverrides(cfgPath);
    if (!loaded.chats['dc:123'].exemptSenders.includes('alice')) {
      loaded.chats['dc:123'].exemptSenders.push('alice');
    }
    saveTriggerOverrides(loaded, cfgPath);
    const reloaded = loadTriggerOverrides(cfgPath);
    expect(reloaded.chats['dc:123'].exemptSenders).toEqual(['alice']);
  });

  it('removes a sender', () => {
    const config = {
      chats: { 'dc:123': { exemptSenders: ['alice', 'bob'] } },
    };
    saveTriggerOverrides(config, cfgPath);
    const loaded = loadTriggerOverrides(cfgPath);
    loaded.chats['dc:123'].exemptSenders = loaded.chats[
      'dc:123'
    ].exemptSenders.filter((s) => s !== 'alice');
    saveTriggerOverrides(loaded, cfgPath);
    const reloaded = loadTriggerOverrides(cfgPath);
    expect(reloaded.chats['dc:123'].exemptSenders).toEqual(['bob']);
  });

  it('cleans up empty entries', () => {
    const config = {
      chats: { 'dc:123': { exemptSenders: ['alice'] } },
    };
    saveTriggerOverrides(config, cfgPath);
    const loaded = loadTriggerOverrides(cfgPath);
    delete loaded.chats['dc:123'];
    saveTriggerOverrides(loaded, cfgPath);
    const reloaded = loadTriggerOverrides(cfgPath);
    expect(reloaded.chats['dc:123']).toBeUndefined();
  });

  it('per-chat isolation', () => {
    writeConfig({
      chats: {
        'dc:123': { exemptSenders: ['alice'] },
        'dc:456': { exemptSenders: ['bob'] },
      },
    });
    const config = loadTriggerOverrides(cfgPath);
    expect(config.chats['dc:123'].exemptSenders.includes('bob')).toBe(false);
    expect(config.chats['dc:456'].exemptSenders.includes('alice')).toBe(false);
  });

  it('lists all exemptions', () => {
    writeConfig({
      chats: {
        'dc:123': { exemptSenders: ['alice'] },
        'dc:456': { exemptSenders: ['bob'] },
      },
    });
    const config = loadTriggerOverrides(cfgPath);
    const result: Record<string, string[]> = {};
    for (const [jid, entry] of Object.entries(config.chats)) {
      result[jid] = entry.exemptSenders;
    }
    expect(result).toEqual({
      'dc:123': ['alice'],
      'dc:456': ['bob'],
    });
  });
});
