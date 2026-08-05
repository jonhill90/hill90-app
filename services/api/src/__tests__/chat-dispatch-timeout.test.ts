/**
 * dispatchChatWork's fetch to agentbox carried no timeout at all — every
 * other agentbox-facing fetch in this codebase (chat.ts's screenshot and
 * browser-action proxies) already had one. agentbox's own handle_work()
 * does not wait on the chat completing; it acks immediately after starting
 * a background thread, so a hang here means the API's OWN request to
 * agentbox never got an ack — not that the chat itself is slow.
 *
 * REACHABLE BY A REAL USER, not just a malformed request: POST
 * /chat/threads and POST /chat/threads/:id/messages both call this on the
 * ordinary "send a message" path. A network-partitioned or wedged agentbox
 * container is ordinary infrastructure flakiness, not misuse — and by the
 * time this fetch is made, the thread and user-message rows are already
 * committed (routes/chat.ts's own transaction comment), so a hang here
 * left committed rows with no dispatch outcome ever recorded.
 *
 * WHAT THIS TEST PROVES. That a fetch which never resolves on its own is
 * now bounded — dispatchChatWork's returned promise rejects instead of
 * hanging forever. It does NOT re-prove that a rejected dispatch gets
 * recorded as a failure — routes-chat.test.ts's "dispatch failure marks
 * placeholder as error" (I14a) and "persists the actual dispatch failure
 * reason" tests already cover that generically for ANY dispatchChatWork
 * rejection, and this fix relies on that existing mechanism rather than
 * duplicating it: adding the timeout is what makes a hang reach it at all.
 */
import { dispatchChatWork } from '../services/chat-dispatch';

const REAL_ABORT_SIGNAL_TIMEOUT = AbortSignal.timeout;
const REAL_FETCH = global.fetch;

const PARAMS = {
  agentId: 'scout',
  workToken: 'work-token-1',
  threadId: 'thread-1',
  messageId: 'msg-1',
  messages: [{ role: 'user', content: 'hello' }],
  model: 'gpt-4o-mini',
  callbackUrl: 'http://api:3000/internal/chat/callback',
};

afterEach(() => {
  (AbortSignal as any).timeout = REAL_ABORT_SIGNAL_TIMEOUT;
  global.fetch = REAL_FETCH;
});

describe('dispatchChatWork does not hang forever on an unresponsive agentbox', () => {
  it('POSITIVE CONTROL: a fetch that never resolves on its own is aborted once the timeout elapses, not left hanging', async () => {
    // Real AbortSignal.timeout(10_000) would make this test slow for no
    // reason — stand in a short-lived controller so the MECHANISM (fetch
    // respecting an abort signal, dispatchChatWork's promise settling
    // because of it) is proven without waiting out the real production
    // duration.
    const controller = new AbortController();
    (AbortSignal as any).timeout = jest.fn((_ms: number) => {
      setTimeout(() => controller.abort(), 20);
      return controller.signal;
    });

    // Mimics real fetch's contract: given a signal, it rejects when that
    // signal aborts. Otherwise it never resolves — the hang this fix
    // exists to bound.
    global.fetch = jest.fn((_url: any, opts: any) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      });
    })) as any;

    await expect(dispatchChatWork(PARAMS)).rejects.toThrow(/aborted|timeout/i);

    // Confirms the timeout was actually wired to the real bound this fix
    // sets, not some other value.
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
  });

  it('GUARD RAIL: a normal, promptly-resolving fetch is unaffected by the added signal', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accepted: true, work_id: 'work-1' }),
    }) as any;

    const result = await dispatchChatWork(PARAMS);

    expect(result).toEqual({ accepted: true, work_id: 'work-1' });
    const callOpts = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(callOpts.signal).toBeInstanceOf(AbortSignal);
  });
});
