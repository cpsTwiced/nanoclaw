/**
 * Codex CLI provider for NanoClaw v2.
 *
 * Bridges v2's push/end model to Codex's turn/steer JSON-RPC protocol.
 * Spawns a single `codex app-server` process per container, reused across turns.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CodexAppServerClient, type AppServerInputItem } from './app-server-client.js';
import type { AppServerTurnEvent } from './app-server-state.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from '../types.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

/**
 * Async event queue. Producers push events, consumer iterates via for-await.
 * Used to bridge Codex's callback-driven notifications to the poll-loop's
 * async iterable consumption.
 */
class EventQueue {
  private queue: ProviderEvent[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(event: ProviderEvent): void {
    if (this.done) return;
    this.queue.push(event);
    this.waiting?.();
  }

  close(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// Match errors from thread resume failures
const STALE_SESSION_RE = /thread.*not found|invalid thread|unknown thread|no such thread/i;

/**
 * Resolve `@<path>` import directives in CLAUDE.md content.
 * Only handles top-level @-imports (one per line at the start of a line).
 */
function resolveImports(content: string, baseDir: string): string {
  const lines = content.split('\n');
  const resolved: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@(.+)$/);
    if (match) {
      const importPath = path.resolve(baseDir, match[1].trim());
      if (fs.existsSync(importPath)) {
        resolved.push(fs.readFileSync(importPath, 'utf-8'));
      } else {
        log(`Import not found: ${importPath}`);
        resolved.push(line);
      }
    } else {
      resolved.push(line);
    }
  }

  return resolved.join('\n');
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private codexModel?: string;
  private codexEffort?: string;

  private client: CodexAppServerClient | null = null;
  private threadId: string | null = null;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.codexModel = this.env.CODEX_MODEL || undefined;
    this.codexEffort = this.env.CODEX_EFFORT || undefined;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const events = new EventQueue();
    let ending = false;
    let aborted = false;
    let activeTurnHandle: {
      steer: (nextInput: AppServerInputItem[]) => Promise<void>;
      interrupt: () => Promise<void>;
    } | null = null;
    let pendingInput: string[] = [];

    // Signal used to wake the run loop when push/end/abort is called between turns
    let wakeRunLoop: (() => void) | null = null;

    const runQuery = async () => {
      try {
        // If the client's process died (panic, crash), reset so we start fresh
        if (this.client?.isDead) {
          log('App-server process died, resetting client');
          this.client = null;
        }

        // Start or reuse app-server process
        if (!this.client) {
          // Ensure git repo exists (Codex requires it) — only before starting a
          // new app-server, never while one is already running against the workspace
          if (!fs.existsSync(path.join(input.cwd, '.git'))) {
            log('Initializing git repo for Codex');
            execFileSync('git', ['init'], { cwd: input.cwd, stdio: 'ignore' });
          }
          this.client = new CodexAppServerClient({
            cwd: input.cwd,
            env: { ...process.env, ...this.filterEnv() },
            log,
          });

          this.client.setOnProcessExit((error) => {
            events.push({ type: 'error', message: error.message, retryable: false });
            events.close();
          });

          // Write config.toml for MCP servers before starting
          this.writeConfigToml();

          await this.client.start();
        }

        // Build developer instructions from CLAUDE.md + system context
        const instructions = this.buildInstructions(input);

        // Start or resume thread
        const threadId = await this.client.startOrResumeThread(input.continuation, {
          cwd: input.cwd,
          model: this.codexModel,
          developerInstructions: instructions,
        });
        this.threadId = threadId;

        events.push({ type: 'init', continuation: threadId });

        // Run turn loop
        let prompt = input.prompt;
        while (!aborted) {
          // Start a turn
          const onEvent = (event: AppServerTurnEvent) => {
            events.push({ type: 'activity' });

            if (event.method === 'item/completed') {
              const item = event.params?.item as { type?: string; text?: string; phase?: string } | undefined;
              if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
                if (item.phase === 'final_answer') {
                  events.push({ type: 'result', text: item.text });
                } else {
                  events.push({ type: 'progress', message: item.text });
                }
              }
            }

            if (event.method === 'error') {
              const error = event.params?.error as { message?: string; codexErrorInfo?: { httpStatusCode?: number } } | undefined;
              const msg = error?.message || 'Codex error';
              const httpStatus = error?.codexErrorInfo?.httpStatusCode;
              events.push({
                type: 'error',
                message: typeof httpStatus === 'number' ? `${msg} (HTTP ${httpStatus})` : msg,
                retryable: false,
                classification: httpStatus === 429 ? 'quota' : undefined,
              });
            }
          };

          const turnHandle = await this.client.startTurn(threadId, [{ type: 'text', text: prompt }], {
            cwd: input.cwd,
            model: this.codexModel,
            effort: this.codexEffort,
            onEvent,
          });

          activeTurnHandle = turnHandle;

          // Wait for turn completion, handling steers from push()
          const result = await turnHandle.wait();
          activeTurnHandle = null;

          // Emit final result if not already emitted via item/completed
          if (result.state.status === 'failed') {
            const msg = result.state.errorMessage || 'Codex turn failed';
            events.push({ type: 'error', message: msg, retryable: false });
          }

          // Check if we should continue
          if (ending || aborted) break;

          // Check for pending input
          if (pendingInput.length > 0) {
            prompt = pendingInput.join('\n\n');
            pendingInput = [];
            continue;
          }

          // No pending input — wait for push() or end()
          await new Promise<void>((resolve) => {
            wakeRunLoop = resolve;
          });
          wakeRunLoop = null;

          if (ending || aborted) break;

          if (pendingInput.length > 0) {
            prompt = pendingInput.join('\n\n');
            pendingInput = [];
            continue;
          }

          // Shouldn't reach here, but break to be safe
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Query error: ${msg}`);
        events.push({ type: 'error', message: msg, retryable: false });
        if (this.client?.isDead) {
          this.client = null;
        }
      } finally {
        events.close();
      }
    };

    // Fire and forget — events are consumed via the async iterable
    runQuery();

    return {
      push: (message: string) => {
        if (ending || aborted) return;

        if (activeTurnHandle) {
          // Steer the active turn with follow-up input
          activeTurnHandle.steer([{ type: 'text', text: message }]).catch((err) => {
            log(`Steer error: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          // Queue for next turn
          pendingInput.push(message);
          wakeRunLoop?.();
        }
      },

      end: () => {
        // Two-strike pattern: first call is gentle (let active turn finish),
        // second call force-kills the app-server if the turn is still stuck
        if (ending && activeTurnHandle && this.client) {
          log('Force-killing app-server: turn stuck after end()');
          this.client.kill();
          this.client = null;
        }
        ending = true;
        wakeRunLoop?.();
      },

      events: events as unknown as AsyncIterable<ProviderEvent>,

      abort: () => {
        aborted = true;
        ending = true;
        if (activeTurnHandle) {
          activeTurnHandle.interrupt().catch(() => {});
        }
        wakeRunLoop?.();
        this.client?.close().catch(() => {});
        this.client = null;
      },
    };
  }

  private buildInstructions(input: QueryInput): string {
    const parts: string[] = [];

    // Read and resolve CLAUDE.md from the working directory
    const claudeMdPath = path.join(input.cwd, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const raw = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push(resolveImports(raw, input.cwd));
    }

    // Append system context (destinations addendum)
    if (input.systemContext?.instructions) {
      parts.push(input.systemContext.instructions);
    }

    return parts.join('\n\n');
  }

  private writeConfigToml(): void {
    const codexHome = process.env.CODEX_HOME || '/home/node/.codex';
    fs.mkdirSync(codexHome, { recursive: true });

    const tomlLines: string[] = [];
    for (const [name, config] of Object.entries(this.mcpServers)) {
      tomlLines.push(`[mcp_servers.${name}]`);
      tomlLines.push(`command = "${config.command}"`);
      tomlLines.push(`args = ${JSON.stringify(config.args)}`);
      tomlLines.push('');
      if (Object.keys(config.env).length > 0) {
        tomlLines.push(`[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(config.env)) {
          tomlLines.push(`${k} = "${v}"`);
        }
        tomlLines.push('');
      }
    }

    if (tomlLines.length > 0) {
      fs.writeFileSync(path.join(codexHome, 'config.toml'), tomlLines.join('\n'));
      log(`Wrote config.toml with ${Object.keys(this.mcpServers).length} MCP server(s)`);
    }
  }

  private filterEnv(): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (v !== undefined) filtered[k] = v;
    }
    return filtered;
  }
}
