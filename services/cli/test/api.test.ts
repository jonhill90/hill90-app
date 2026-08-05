import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hill90Client } from '../src/api';

// streamResponse silently returned nothing on a failed request instead of
// throwing — the operator saw "agent> " followed by a blank line, identical
// to what a legitimately empty response looks like. There was no way to tell
// "the agent said nothing" from "the request to fetch the agent's response
// failed" (expired token, thread deleted, server error). This is the same
// family as request()'s own handling three lines above it in api.ts, which
// DOES throw on !res.ok — streamResponse was the one path that didn't.
test('streamResponse throws on a non-ok status instead of yielding nothing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('token expired', { status: 401 })) as typeof fetch;

  try {
    const client = new Hill90Client('https://example.com', 'tok');
    const chunks: string[] = [];
    await assert.rejects(async () => {
      for await (const chunk of client.streamResponse('thread-1')) {
        chunks.push(chunk);
      }
    }, /401/);
    assert.deepEqual(chunks, [], 'no chunks should have been yielded before the throw');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamResponse yields chunks normally on a real SSE stream', async () => {
  const originalFetch = globalThis.fetch;
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: {"content":"hi"}\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;

  try {
    const client = new Hill90Client('https://example.com', 'tok');
    const chunks: string[] = [];
    for await (const chunk of client.streamResponse('thread-1')) {
      chunks.push(chunk);
    }
    assert.deepEqual(chunks, ['hi']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
