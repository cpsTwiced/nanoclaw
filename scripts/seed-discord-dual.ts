/**
 * Register both Claude and Codex agents to a single Discord channel.
 *
 * Usage: npx tsx scripts/seed-discord-dual.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
} from '../src/db/messaging-groups.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const GUILD_ID = '1490547495196164168';
const CHANNEL_ID = '1493860419469709332';

// Existing agent groups
const CLAUDE_AGENT_ID = 'ag-1776200429650-sz179y'; // Hard Working Gomsik
const CODEX_AGENT_ID = 'ag-1776206796446-ainauy'; // Hard Working Sudal

// Verify agent groups exist
for (const id of [CLAUDE_AGENT_ID, CODEX_AGENT_ID]) {
  const ag = getAgentGroup(id);
  if (!ag) {
    console.error(`Agent group ${id} not found!`);
    process.exit(1);
  }
  console.log(`Found agent group: ${ag.name} (${ag.agent_provider || 'claude'})`);
}

// 1. Discord (Claude) messaging group
const MG_CLAUDE_ID = 'mg-discord-dual-claude';
const PLATFORM_ID_CLAUDE = `discord:${GUILD_ID}:${CHANNEL_ID}`;

if (!getMessagingGroup(MG_CLAUDE_ID)) {
  createMessagingGroup({
    id: MG_CLAUDE_ID,
    channel_type: 'discord',
    platform_id: PLATFORM_ID_CLAUDE,
    name: 'Dual Test (Claude)',
    is_group: 1,
    admin_user_id: null,
    created_at: new Date().toISOString(),
  });
  console.log('Created messaging group:', MG_CLAUDE_ID);
} else {
  console.log('Messaging group already exists:', MG_CLAUDE_ID);
}

// 2. Discord-Codex messaging group
const MG_CODEX_ID = 'mg-discord-dual-codex';
const PLATFORM_ID_CODEX = `discord:${GUILD_ID}:${CHANNEL_ID}`;

if (!getMessagingGroup(MG_CODEX_ID)) {
  createMessagingGroup({
    id: MG_CODEX_ID,
    channel_type: 'discord-codex',
    platform_id: PLATFORM_ID_CODEX,
    name: 'Dual Test (Codex)',
    is_group: 1,
    admin_user_id: null,
    created_at: new Date().toISOString(),
  });
  console.log('Created messaging group:', MG_CODEX_ID);
} else {
  console.log('Messaging group already exists:', MG_CODEX_ID);
}

// 3. Wire Claude agent to discord messaging group
try {
  createMessagingGroupAgent({
    id: 'mga-dual-claude',
    messaging_group_id: MG_CLAUDE_ID,
    agent_group_id: CLAUDE_AGENT_ID,
    trigger_rules: null,
    response_scope: 'all',
    session_mode: 'shared',
    priority: 10,
    created_at: new Date().toISOString(),
  });
  console.log('Wired Claude agent to discord channel');
} catch (err: any) {
  if (err.message?.includes('UNIQUE')) {
    console.log('Claude wiring already exists');
  } else {
    throw err;
  }
}

// 4. Wire Codex agent to discord-codex messaging group
try {
  createMessagingGroupAgent({
    id: 'mga-dual-codex',
    messaging_group_id: MG_CODEX_ID,
    agent_group_id: CODEX_AGENT_ID,
    trigger_rules: null,
    response_scope: 'all',
    session_mode: 'shared',
    priority: 10,
    created_at: new Date().toISOString(),
  });
  console.log('Wired Codex agent to discord-codex channel');
} catch (err: any) {
  if (err.message?.includes('UNIQUE')) {
    console.log('Codex wiring already exists');
  } else {
    throw err;
  }
}

console.log('\nDone! Both agents are now wired to Discord channel', CHANNEL_ID);
console.log('Restart NanoClaw to pick up the changes.');
