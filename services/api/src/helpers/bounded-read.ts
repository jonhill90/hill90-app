/**
 * Read a stream into memory with a ceiling, enforced as it arrives.
 *
 * The point of this file is the word *incrementally*. Checking a size after the
 * bytes are already in an array is not a cap — the process has paid for them by
 * then, and on a container with no mem_limit the payment is the host's memory.
 * So the counter is checked per chunk and the stream is destroyed the moment it
 * is exceeded, rather than allowed to run to completion.
 *
 * This mirrors services/knowledge/app/services/web_page_fetcher.py, which does
 * the same thing for HTTP bodies ("Stream body with incremental size
 * enforcement") against the same 2 MB figure.
 *
 * Callers must surface ReadTooLargeError to the client as an explicit failure.
 * Returning what happened to fit, formatted to look like a whole answer, is a
 * silent-success defect: the caller cannot tell a small log from a truncated one.
 */

/** 2 MB, the same ceiling web_page_fetcher.py applies to a fetched page. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

export class ReadTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Output exceeds the ${limit}-byte read limit`);
    this.name = 'ReadTooLargeError';
    this.limit = limit;
  }
}

/**
 * Collect a readable stream, aborting as soon as `maxBytes` is passed.
 *
 * Resolves with everything read when the stream ends inside the limit.
 * Rejects with ReadTooLargeError when it does not — having already destroyed
 * the stream, so nothing further is read or buffered.
 */
export function collectBounded(
  stream: NodeJS.ReadableStream,
  maxBytes: number = MAX_READ_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Hang up first, report second. Destroying the stream is what makes
        // this a limit rather than an observation about one.
        (stream as unknown as { destroy?: () => void }).destroy?.();
        chunks.length = 0;
        settle(() => reject(new ReadTooLargeError(maxBytes)));
        return;
      }
      chunks.push(chunk);
    });

    // Destroying the stream above can itself emit 'error' (premature close).
    // `settled` means that arrives after the rejection and is discarded.
    stream.on('error', (err: Error) => settle(() => reject(err)));
    stream.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    stream.on('close', () => settle(() => resolve(Buffer.concat(chunks))));
  });
}
