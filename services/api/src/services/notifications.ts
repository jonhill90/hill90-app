import { getPool } from '../db/pool';

export type NotificationType = 'agent_start' | 'agent_stop' | 'agent_error' | 'info';

/**
 * Create a notification for a user. Fire-and-forget — never throws.
 */
export function notify(
  userId: string,
  message: string,
  type: NotificationType = 'info',
  metadata?: Record<string, unknown>
): void {
  // SAFE ONLY BECAUSE OF THE CALLEE. `void` attaches no rejection handler, so this
  // line's safety is entirely `insertNotification`'s: its body is one try/catch that
  // logs and returns. Remove or narrow that try and this becomes #133 exactly — an
  // unhandled rejection, and Node 20 exits the process on one because this service
  // registers no handler (boot/fatal.ts installs a backstop that logs it, nothing more).
  void insertNotification(userId, message, type, metadata);
}

async function insertNotification(
  userId: string,
  message: string,
  type: NotificationType,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO notifications (user_id, message, type, metadata) VALUES ($1, $2, $3, $4)`,
      [userId, message, type, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error(`[notifications] Failed to insert for ${userId}:`, err);
  }
}
