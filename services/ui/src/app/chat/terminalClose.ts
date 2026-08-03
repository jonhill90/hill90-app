/**
 * What the user is told when a terminal socket closes.
 *
 * Every close code except these auto-reconnects with a server-refreshed token
 * and heals invisibly, so a code that does NOT reconnect and says nothing leaves
 * a dead pane that reads as a network blip — the one failure the user cannot
 * distinguish from a glitch, and the one they could actually act on.
 *
 * 4001 — the credential was refused. agentbox closes with this
 *        (services/agentbox/app/ws_terminal.py).
 * 4002 — the credential was accepted and has since run out. The api terminal
 *        proxy ends a session when its token does.
 *
 * They are separate codes on purpose: a client cannot behave differently about
 * two conditions that arrive as the same number.
 */

export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_CREDENTIAL_EXPIRED = 4002;

/**
 * Lines to write into the terminal for a close the user should see, or null
 * when the close needs no notice (a normal hang-up, or one that will reconnect).
 */
export function terminalCloseNotice(code: number, reason?: string): string[] | null {
  if (code !== CLOSE_UNAUTHORIZED && code !== CLOSE_CREDENTIAL_EXPIRED) return null;

  const why =
    reason && reason.trim().length > 0
      ? reason.trim()
      : code === CLOSE_CREDENTIAL_EXPIRED
        ? 'credential expired'
        : 'not authorized';

  return [
    `\r\n\x1b[33m[terminal closed: ${why}]\x1b[0m\r\n`,
    '\x1b[2mReload the page to start a new session.\x1b[0m\r\n',
  ];
}

/** True when the client should attempt its reconnect sequence. */
export function shouldReconnect(code: number): boolean {
  return code !== CLOSE_UNAUTHORIZED && code !== CLOSE_CREDENTIAL_EXPIRED && code !== 1000;
}
