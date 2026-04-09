import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  CODEX_ASSISTANT_NAME,
  botConversationLimit,
  escapeRegex,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name: string;

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private jidPrefix: string;
  private triggerName: string;
  // Bot-to-bot turn counter per channel (reset on human message)
  private botTurnCounts = new Map<string, number>();
  // Static registry: triggerName → Discord bot user ID (shared across instances)
  private static botRegistry = new Map<string, string>();

  constructor(
    botToken: string,
    jidPrefix: string,
    triggerName: string,
    channelName: string,
    opts: DiscordChannelOpts,
  ) {
    this.botToken = botToken;
    this.jidPrefix = jidPrefix;
    this.triggerName = triggerName;
    this.name = channelName;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      const isOwnMessage =
        this.client?.user && message.author.id === this.client.user.id;
      if (isOwnMessage) return;

      const channelId = message.channelId;
      const chatJid = `${this.jidPrefix}${channelId}`;
      const botId = this.client?.user?.id;

      // Bot-to-bot turn tracking
      if (message.author.bot) {
        // Only allow bot messages that @mention this bot
        if (!botId) return;
        const mentionsMe =
          message.mentions.users.has(botId) ||
          message.content.includes(`<@${botId}>`) ||
          message.content.includes(`<@!${botId}>`);
        if (!mentionsMe) return;

        // Check per-group turn cap (fall back to global default)
        const group = this.opts.registeredGroups()[chatJid];
        const limit = group?.botConversationLimit ?? botConversationLimit;
        if (limit === 0) return; // bot-to-bot disabled for this group
        const turns = this.botTurnCounts.get(channelId) || 0;
        if (turns >= limit) {
          logger.info(
            { channelId, turns, limit },
            'Bot-to-bot conversation limit reached, ignoring',
          );
          return;
        }
        this.botTurnCounts.set(channelId, turns + 1);
      } else {
        // Human message resets the counter
        this.botTurnCounts.set(channelId, 0);

        // Filter messages targeting other bots (not this one)
        // Layer A: Discord native @mentions
        const mentionedBots = message.mentions.users.filter((u) => u.bot);
        if (mentionedBots.size > 0 && botId && !mentionedBots.has(botId)) {
          return;
        }

        // Layer B: Plain text trigger prefixes (for trigger-exempt bypass)
        const rawContent = message.content.trim();
        for (const [triggerName] of DiscordChannel.botRegistry) {
          if (triggerName === this.triggerName) continue;
          const otherTrigger = new RegExp(
            `^@${escapeRegex(triggerName)}\\b`,
            'i',
          );
          if (otherTrigger.test(rawContent)) {
            return;
          }
        }
      }

      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into trigger format.
      // Discord mentions look like <@botUserId> — these won't match
      // the group's trigger pattern, so we prepend the trigger name
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger using this channel's trigger name
          const triggerPattern = new RegExp(
            `^@${this.triggerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          );
          if (!triggerPattern.test(content)) {
            content = `@${this.triggerName} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        this.name,
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        DiscordChannel.botRegistry.set(this.triggerName, readyClient.user.id);
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc\d?:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Strip self-mentions to prevent self-triggering
      const selfPattern = new RegExp(
        `@${escapeRegex(this.triggerName)}\\b`,
        'gi',
      );
      text = text.replace(selfPattern, '').trim();
      const botId = this.client?.user?.id;
      if (botId) {
        text = text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      }

      // Convert other bot trigger mentions to Discord <@id> mentions
      for (const [triggerName, userId] of DiscordChannel.botRegistry) {
        if (triggerName === this.triggerName) continue;
        const otherPattern = new RegExp(
          `@${escapeRegex(triggerName)}\\b`,
          'gi',
        );
        text = text.replace(otherPattern, `<@${userId}>`);
      }

      if (!text) return; // Nothing left after stripping

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(this.jidPrefix);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      DiscordChannel.botRegistry.delete(this.triggerName);
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc\d?:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, 'dc:', ASSISTANT_NAME, 'discord', opts);
});

registerChannel('discord-codex', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'DISCORD_CODEX_BOT_TOKEN',
    'CODEX_ASSISTANT_NAME',
  ]);
  const token =
    process.env.DISCORD_CODEX_BOT_TOKEN ||
    envVars.DISCORD_CODEX_BOT_TOKEN ||
    '';
  if (!token) return null;
  return new DiscordChannel(
    token,
    'dc2:',
    CODEX_ASSISTANT_NAME,
    'discord-codex',
    opts,
  );
});
