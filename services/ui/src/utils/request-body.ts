/**
 * Read a request body with a hard ceiling on how much memory it may consume.
 *
 * THE DEFECT THIS EXISTS FOR. Every proxy route in this app read the whole body
 * into the Next.js process first and asked questions later:
 *
 *     fetchOpts.body = await req.arrayBuffer()   // storage, agents, profile
 *     fetchOpts.body = await req.text()          // api-proxy, 35 routes
 *
 * and nothing in `services/ui` set a size limit — no `bodyParser`, no
 * `sizeLimit`, no `Content-Length` check. The API behind it does have caps:
 * `express.json()` defaults to 100kb, and multer stops uploads at 5MB (avatars)
 * and 50MB (storage). So the shape was: the ui allocates the entire body, then
 * forwards it to a service that refuses it. A signed-in user posting 2GB made
 * the ui allocate 2GB, and the 50MB refusal arrived after the harm. `ui`
 * declares no `mem_limit` (#144) on a VPS shared with the platform, so the
 * pressure is host-level rather than container-level.
 *
 * WHY CONTENT-LENGTH ALONE IS NOT THE FIX. It is a claim by the client. A
 * chunked request carries no `Content-Length` at all, and a lying one is a
 * header edit. Checking it and then calling `arrayBuffer()` anyway would be a
 * report, not a limit. So the header is only a cheap early refusal, and the
 * ACTUAL control is counting bytes during the read and abandoning it the moment
 * the ceiling is crossed. Same distinction as #143, where enforcing during the
 * read was the whole point.
 *
 * WHAT THE CALLER SEES. A refusal is `413` with an explicit error naming the
 * limit. It is never an empty success: a proxy that returns a quiet zero-length
 * body on refusal is the silent-success family this estate keeps finding, and
 * it would surface to a user as "the upload worked and the file is empty".
 *
 * The ceilings sit at or above the API's own, so nothing that works today stops
 * working — this bounds memory, it does not tighten the product's limits. The
 * API remains the authority on what is actually acceptable.
 */

/** Generic JSON proxy. The API's `express.json()` refuses above 100kb. */
export const BODY_LIMIT_JSON = 1024 * 1024

/** Avatar/image uploads. multer refuses above 5MB in agents.ts and profile.ts. */
export const BODY_LIMIT_AVATAR = 8 * 1024 * 1024

/** Object storage uploads. multer refuses above 50MB in storage.ts. */
export const BODY_LIMIT_UPLOAD = 64 * 1024 * 1024

export class BodyTooLargeError extends Error {
  constructor(
    readonly limit: number,
    readonly declared: number | null,
  ) {
    super(`request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read at most `limit` bytes from the request, or refuse.
 *
 * Refuses without reading when the declared length already exceeds the limit,
 * and refuses mid-read when the actual bytes do — the second is the one that
 * holds when the first is absent or false.
 */
export async function readBodyLimited(
  req: {
    headers: { get(name: string): string | null }
    // `| undefined` as well as `| null`: the spec says null for "no body", but a
    // caller that simply does not set it must be treated as no body too, never
    // dereferenced. Throwing on undefined would turn a bodiless request into a
    // 500 rather than an empty read.
    body?: ReadableStream<Uint8Array> | null
  },
  limit: number,
): Promise<ArrayBuffer> {
  const header = req.headers.get('content-length')
  const declared = header === null ? null : Number(header)

  // Cheap refusal, before a single byte is read. Deliberately NOT trusted as
  // the control: a NaN, an absent header or a lie all fall through to the
  // counted read below.
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    throw new BodyTooLargeError(limit, declared)
  }

  if (req.body === null || req.body === undefined) {
    return new ArrayBuffer(0)
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      if (total > limit) {
        // Abandon the rest rather than draining it. Reading on to "see how big
        // it really is" would hand the caller exactly the allocation this is
        // meant to prevent, and the answer would not change the outcome.
        await reader.cancel().catch(() => {})
        throw new BodyTooLargeError(limit, declared)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  // An ArrayBuffer, not a Uint8Array: `BodyInit` accepts the former directly,
  // and the callers hand this straight to fetch().
  const buf = new ArrayBuffer(total)
  const out = new Uint8Array(buf)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buf
}

/** Same, decoded as UTF-8, for the JSON proxy paths. */
export async function readTextLimited(
  req: {
    headers: { get(name: string): string | null }
    body?: ReadableStream<Uint8Array> | null
  },
  limit: number,
): Promise<string> {
  const bytes = await readBodyLimited(req, limit)
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The 413 a refusal must produce. Never an empty 200. */
export function bodyTooLargeResponse(err: BodyTooLargeError): Response {
  return new Response(
    JSON.stringify({
      error: 'Request body too large',
      limit_bytes: err.limit,
      detail: `This request exceeds the ${err.limit} byte limit for this endpoint.`,
    }),
    {
      status: 413,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    },
  )
}
