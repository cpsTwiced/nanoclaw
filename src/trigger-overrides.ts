import fs from 'fs';

import { TRIGGER_OVERRIDES_PATH } from './config.js';
import { logger } from './logger.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from './sender-allowlist.js';
import { NewMessage } from './types.js';

export interface TriggerOverrideEntry {
  exemptSenders: string[];
}

export interface TriggerOverridesConfig {
  chats: Record<string, TriggerOverrideEntry>;
}

const DEFAULT_CONFIG: TriggerOverridesConfig = { chats: {} };

let cachedConfig: TriggerOverridesConfig | null = null;

function isValidEntry(entry: unknown): entry is TriggerOverrideEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    Array.isArray(e.exemptSenders) &&
    e.exemptSenders.every((v: unknown) => typeof v === 'string')
  );
}

export function loadTriggerOverrides(
  pathOverride?: string,
): TriggerOverridesConfig {
  const filePath = pathOverride ?? TRIGGER_OVERRIDES_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'trigger-overrides: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'trigger-overrides: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;
  const chats: Record<string, TriggerOverrideEntry> = {};

  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'trigger-overrides: skipping invalid chat entry',
        );
      }
    }
  }

  return { chats };
}

export function isTriggerExempt(chatJid: string, sender: string): boolean {
  if (!cachedConfig) {
    cachedConfig = loadTriggerOverrides();
  }
  const entry = cachedConfig.chats[chatJid];
  if (!entry) return false;
  return entry.exemptSenders.includes(sender);
}

/**
 * Check whether any message in a batch should activate the agent.
 * Returns true if at least one message is from self, from an exempt sender,
 * or matches the trigger pattern from an allowed sender.
 */
export function hasTriggerMatch(
  chatJid: string,
  messages: NewMessage[],
  triggerPattern: RegExp,
): boolean {
  const allowlistCfg = loadSenderAllowlist();
  return messages.some(
    (m) =>
      m.is_from_me ||
      isTriggerExempt(chatJid, m.sender) ||
      (triggerPattern.test(m.content.trim()) &&
        isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
  );
}

/** Force reload from disk. */
export function reloadTriggerOverrides(): void {
  cachedConfig = null;
}

/** Save config to disk, bust cache. */
export function saveTriggerOverrides(
  config: TriggerOverridesConfig,
  pathOverride?: string,
): void {
  const filePath = pathOverride ?? TRIGGER_OVERRIDES_PATH;
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  cachedConfig = null;
}

/** Add an exempt sender to a chat. Returns true if added, false if already present. */
export function addExemptSender(chatJid: string, sender: string): boolean {
  const config = loadTriggerOverrides();
  if (!config.chats[chatJid]) {
    config.chats[chatJid] = { exemptSenders: [] };
  }
  if (config.chats[chatJid].exemptSenders.includes(sender)) {
    return false;
  }
  config.chats[chatJid].exemptSenders.push(sender);
  saveTriggerOverrides(config);
  return true;
}

/** Remove an exempt sender from a chat. Returns true if removed, false if not found. */
export function removeExemptSender(chatJid: string, sender: string): boolean {
  const config = loadTriggerOverrides();
  const entry = config.chats[chatJid];
  if (!entry) return false;
  const idx = entry.exemptSenders.indexOf(sender);
  if (idx === -1) return false;
  entry.exemptSenders.splice(idx, 1);
  // Clean up empty entries
  if (entry.exemptSenders.length === 0) {
    delete config.chats[chatJid];
  }
  saveTriggerOverrides(config);
  return true;
}

/** List all exemptions, optionally filtered by chat. */
export function listExemptSenders(
  chatJid?: string,
): Record<string, string[]> {
  const config = loadTriggerOverrides();
  if (chatJid) {
    const entry = config.chats[chatJid];
    return entry ? { [chatJid]: entry.exemptSenders } : {};
  }
  const result: Record<string, string[]> = {};
  for (const [jid, entry] of Object.entries(config.chats)) {
    result[jid] = entry.exemptSenders;
  }
  return result;
}
