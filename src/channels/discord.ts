/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Resolve Discord `<@userId>` mentions to `@displayName` in inbound message text.
 * Uses the `mentions` array from the raw Discord payload.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveMentions(serialized: Record<string, any>, raw: Record<string, any>): void {
  if (!serialized.text || !Array.isArray(raw.mentions) || raw.mentions.length === 0) return;
  let text = serialized.text as string;
  for (const user of raw.mentions) {
    if (!user.id) continue;
    const name = user.global_name || user.username || user.id;
    text = text.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${name}`);
  }
  serialized.text = text;
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
    });
  },
});

// Second Discord bot for Codex agent groups
registerChannelAdapter('discord-codex', {
  factory: () => {
    const env = readEnvFile(['DISCORD_CODEX_BOT_TOKEN', 'DISCORD_CODEX_PUBLIC_KEY', 'DISCORD_CODEX_APPLICATION_ID']);
    if (!env.DISCORD_CODEX_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_CODEX_BOT_TOKEN,
      publicKey: env.DISCORD_CODEX_PUBLIC_KEY,
      applicationId: env.DISCORD_CODEX_APPLICATION_ID,
    });
    return createChatSdkBridge({
      adapter: discordAdapter,
      channelType: 'discord-codex',
      concurrency: 'concurrent',
      botToken: env.DISCORD_CODEX_BOT_TOKEN,
      extractReplyContext,
      transformInboundContent: resolveMentions,
      supportsThreads: true,
    });
  },
});
