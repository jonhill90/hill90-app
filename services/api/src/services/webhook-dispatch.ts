import crypto from 'node:crypto';
import { getPool } from '../db/pool';
import { decryptProviderKey, ProviderKeyDecryptionError } from './provider-key-crypto';

export type WebhookEvent = 'start' | 'stop' | 'error';

interface WebhookRow {
  id: string;
  url: string;
  secret_encrypted: Buffer | null;
  secret_nonce: Buffer | null;
}

// app#374 tier two: this function is the WHOLE REASON agent_webhooks.secret
// is encrypted rather than hashed — it must recover the plaintext to HMAC-
// sign outbound deliveries below, unlike workflows.webhook_token (#341),
// which only ever needs a comparison. Same key as routes/agents.ts's
// env_vars encryption; each consuming file reads its own copy of
// PROVIDER_KEY_ENCRYPTION_KEY rather than sharing a cross-file import, same
// established pattern as #372/#386.
function getWebhookSecretEncryptionKey(): string {
  const key = process.env.PROVIDER_KEY_ENCRYPTION_KEY;
  if (!key) throw new Error('PROVIDER_KEY_ENCRYPTION_KEY not configured');
  return key;
}

function decryptWebhookSecret(row: WebhookRow): string | null {
  if (!row.secret_encrypted || !row.secret_nonce) return null;
  return decryptProviderKey(row.secret_encrypted, row.secret_nonce, getWebhookSecretEncryptionKey());
}

/**
 * Fire-and-forget: POST event payload to all active webhooks for an agent.
 * Runs in background — never throws to caller.
 */
export function dispatchWebhooks(
  agentId: string,
  agentUuid: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): void {
  // Run async but don't await — caller should not block on webhook delivery
  // SAFE ONLY BECAUSE OF THE CALLEE. `void` attaches no rejection handler, so this
  // line's safety is entirely `dispatchAsync`'s: its body is one try/catch that
  // logs and returns. Remove or narrow that try and this becomes #133 exactly — an
  // unhandled rejection, and Node 20 exits the process on one because this service
  // registers no handler (boot/fatal.ts installs a backstop that logs it, nothing more).
  void dispatchAsync(agentId, agentUuid, event, payload);
}

async function dispatchAsync(
  agentId: string,
  agentUuid: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { rows } = await getPool().query<WebhookRow>(
      `SELECT id, url, secret_encrypted, secret_nonce FROM agent_webhooks
       WHERE agent_id = $1 AND active = TRUE AND $2 = ANY(events)`,
      [agentUuid, event]
    );

    if (rows.length === 0) return;

    const body = JSON.stringify({
      event,
      agent_id: agentId,
      agent_uuid: agentUuid,
      timestamp: new Date().toISOString(),
      ...payload,
    });

    const deliveries = rows.map((hook) => deliverWebhook(hook, body));
    // app#396: this used to be `await Promise.allSettled(deliveries)` with the
    // result thrown away — the ENTIRE reason allSettled exists here (one bad
    // webhook must not sink the others) also meant a decrypt failure inside
    // deliverWebhook rejected silently into a value nothing ever read. That
    // specific case is now caught inside deliverWebhook itself (see below) and
    // never reaches here as a rejection — but this loop stays as a backstop
    // for any OTHER way deliverWebhook might reject, so this file cannot
    // regress to the same silent-swallow shape for a different reason later.
    const results = await Promise.allSettled(deliveries);
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[webhooks] Unexpected delivery failure for hook ${rows[i].id}:`, result.reason);
      }
    });
  } catch (err) {
    console.error(`[webhooks] Failed to dispatch ${event} for ${agentId}:`, err);
  }
}

const EVENT_COLORS: Record<string, number> = {
  start: 0x5b9a2f,   // brand green
  stop: 0xf59e0b,    // amber
  error: 0xef4444,   // red
};

const EVENT_EMOJI: Record<string, string> = {
  start: '🟢',
  stop: '🟡',
  error: '🔴',
};

function isDiscordWebhook(url: string): boolean {
  return url.includes('discord.com/api/webhooks/') || url.includes('discordapp.com/api/webhooks/');
}

function formatDiscordPayload(event: string, parsed: Record<string, unknown>): string {
  return JSON.stringify({
    embeds: [{
      title: `${EVENT_EMOJI[event] || '⚪'} Agent ${event.charAt(0).toUpperCase() + event.slice(1)}`,
      description: `**${parsed.agent_id}** ${event === 'error' ? `failed: ${parsed.error || 'unknown error'}` : event === 'start' ? 'is now running' : 'has stopped'}`,
      color: EVENT_COLORS[event] || 0x6b7280,
      fields: [
        { name: 'Agent', value: String(parsed.agent_id || 'unknown'), inline: true },
        { name: 'Event', value: event, inline: true },
        ...(parsed.container_id ? [{ name: 'Container', value: String(parsed.container_id).slice(0, 12), inline: true }] : []),
      ],
      timestamp: parsed.timestamp || new Date().toISOString(),
      footer: { text: 'Hill90 Platform' },
    }],
  });
}

async function deliverWebhook(hook: WebhookRow, body: string): Promise<void> {
  const parsed = JSON.parse(body);
  const isDiscord = isDiscordWebhook(hook.url);

  // Discord webhooks get formatted as embeds
  const deliveryBody = isDiscord
    ? formatDiscordPayload(parsed.event || 'unknown', parsed)
    : body;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Hill90-Webhooks/1.0',
  };

  // app#396: a webhook that HAS a secret configured must never be delivered
  // UNSIGNED — a decrypt failure is not the same thing as "no secret was
  // ever set", and treating it that way would silently downgrade a signed
  // webhook to unsigned the moment PROVIDER_KEY_ENCRYPTION_KEY drifts from
  // whatever encrypted this row. So decrypt is resolved BEFORE any network
  // call, and a failure here skips delivery entirely — loudly, via the log
  // line below, not by falling through to an unsigned POST.
  //
  // This used to be `const secret = decryptWebhookSecret(hook);` with no
  // try/catch of its own, sitting inside deliverWebhook but OUTSIDE its one
  // try/catch (which only ever wrapped the fetch call below). A thrown
  // decrypt error rejected this function's returned promise, which
  // dispatchAsync fed straight into `Promise.allSettled` and never
  // inspected — the exact defect family this estate spent tonight closing
  // elsewhere (a failure that reports nothing), newly shipped by #390 the
  // same night, found while auditing the very key #390 introduced a fourth
  // consumer of (#396).
  let secret: string | null;
  try {
    secret = decryptWebhookSecret(hook);
  } catch (err) {
    const reason = err instanceof ProviderKeyDecryptionError
      ? err.message
      : 'unexpected error decrypting the stored secret';
    console.error(
      `[webhooks] SECRET DECRYPTION FAILED for hook ${hook.id} (${hook.url}) — ` +
      `webhook NOT delivered (would have been unsigned). ${reason}`,
      err,
    );
    return;
  }

  if (secret && !isDiscord) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(deliveryBody)
      .digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: deliveryBody,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(`[webhooks] Delivery to ${hook.url} returned ${res.status}`);
    }
  } catch (err) {
    console.warn(`[webhooks] Delivery to ${hook.url} failed:`, err);
  }
}
