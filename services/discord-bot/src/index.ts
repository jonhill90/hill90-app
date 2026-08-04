/**
 * Hill90 Discord Bot — bridges Discord channels to Hill90 agent chat.
 *
 * Each Discord channel can be bound to a Hill90 agent. Messages in bound
 * channels are relayed to the agent via the internal API, and agent
 * responses are sent back to the Discord channel.
 */

import { Client, GatewayIntentBits, Message, Partials } from 'discord.js';

const API_URL = process.env.API_URL || 'http://api:3000';
const SERVICE_TOKEN = process.env.DISCORD_BOT_SERVICE_TOKEN || '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120000;
const MAX_DISCORD_LENGTH = 2000;

if (!BOT_TOKEN) {
  console.error('[discord-bot] DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

if (!SERVICE_TOKEN) {
  console.error('[discord-bot] DISCORD_BOT_SERVICE_TOKEN is required');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

async function apiCall(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function pollForResponse(messageId: string): Promise<{ content: string; error?: string }> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const data = await apiCall('GET', `/internal/discord/poll/${messageId}`);
    if (data.status === 'delivered' || data.status === 'error') {
      return { content: data.content || '', error: data.error || undefined };
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { content: '', error: 'Response timed out after 2 minutes' };
}

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf('\n', MAX_DISCORD_LENGTH);
    if (breakAt < MAX_DISCORD_LENGTH / 2) breakAt = MAX_DISCORD_LENGTH;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return chunks;
}

client.on('ready', () => {
  console.log(`[discord-bot] Logged in as ${client.user?.tag}`);
});

client.on('messageCreate', async (message: Message) => {
  // Ignore bot's own messages and other bots
  if (message.author.bot) return;
  if (!message.guild) return; // DM support future

  const channelId = message.channelId;

  try {
    // Relay to Hill90
    const relayResult = await apiCall('POST', '/internal/discord/message', {
      channel_id: channelId,
      discord_user_id: message.author.id,
      content: message.content,
    });

    // Show typing indicator while waiting
    await message.channel.sendTyping();

    // Poll for agent response
    const response = await pollForResponse(relayResult.assistant_message_id);

    if (response.error) {
      await message.reply(`⚠️ ${response.error}`);
      return;
    }

    if (!response.content) {
      return; // No response content
    }

    // Send response (chunk if needed)
    const chunks = chunkMessage(response.content);
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }
  } catch (err: any) {
    if (err.message?.includes('404')) {
      // Channel not bound — silently ignore
      return;
    }
    console.error(`[discord-bot] Error handling message in ${channelId}:`, err.message);
  }
});

// A REJECTION, not a throw — measured, because it decides the instrument.
// `client.login()` returns a promise; an invalid, revoked or rotated
// DISCORD_BOT_TOKEN rejects it with `TokenInvalid`. Induced with a bad token, the
// failure arrives on `process.on('unhandledRejection')`, so a try/catch around this
// call would not have caught it. discord.js registers no handler of its own and
// neither did this file, so the process died on Node's default with a discord.js
// stack and nothing of ours naming the cause.
//
// WHAT THIS FIXES AND WHAT IT DOES NOT. With `restart: unless-stopped` in
// docker-compose.discord-bot.yml, a bad token still means a container that dies
// forever — this makes each death legible, not survivable. A caught rejection that
// logs and exits is a better obituary, not a working bot. The bot cannot run
// without a valid token, and pretending otherwise (retrying, or staying up
// unauthenticated) would be worse: it would look healthy while relaying nothing.
//
// The exit is deferred one turn on purpose: `console.error` followed immediately by
// `process.exit()` loses the message when stderr is a pipe, which in a container it
// always is — the same trap recorded in services/api/src/boot/fatal.ts.
client.login(BOT_TOKEN).catch((err: unknown) => {
  const code = (err as { code?: string })?.code;
  console.error(`[discord-bot] login failed; the bot cannot start: ${code ?? err}`);
  setImmediate(() => process.exit(1));
});
