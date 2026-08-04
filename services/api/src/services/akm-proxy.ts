/**
 * Thin HTTP client for proxying requests to the knowledge service's
 * internal admin endpoints. Authenticated with AKM_INTERNAL_SERVICE_TOKEN.
 */

import { totalFrom } from '../helpers/upstream-total';

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_INTERNAL_SERVICE_TOKEN = process.env.AKM_INTERNAL_SERVICE_TOKEN;

/**
 * Read an AKM response body without letting the parser replace the real fault.
 *
 * This used to be `await resp.json()` at every call site. FastAPI's default 500 body is
 * the plain text "Internal Server Error", so a genuine AKM failure made the parser
 * throw, and the throw propagated out past the cause. What reached the log was
 * `SyntaxError: Unexpected token 'I', "Internal S"... is not valid JSON`, while the
 * AKM's actual error — a frontmatter validation failure, in the case that found this —
 * was nowhere.
 *
 * A non-JSON body is now returned AS the error, with the upstream status preserved, so
 * the caller sees what the knowledge service actually said.
 */
async function readBody(resp: Response): Promise<unknown> {
  let text: string;
  try {
    text = await resp.text();
  } catch {
    return { error: `Knowledge service response could not be read (HTTP ${resp.status})` };
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    // Truncated: an upstream that returns a page of HTML should not put a page of HTML
    // into our logs, but the first few hundred characters are where the cause lives.
    return {
      error: `Knowledge service returned a non-JSON response (HTTP ${resp.status})`,
      upstream_status: resp.status,
      upstream_body: text.slice(0, 500),
    };
  }
}


export interface ProxyResponse {
  status: number;
  data: unknown;
  /**
   * The number of rows matching the request upstream, from `X-Total-Count` —
   * NOT the length of the page in `data`. Null when the response is not a
   * list at all.
   *
   * The distinction is the whole point (#188). `data.length` was the true
   * total until #182 bounded the knowledge endpoint at 500 rows, after which
   * it silently became the size of the page and an agent with 40,000 entries
   * reported 500.
   */
  total: number | null;
}

/**
 * Read the real total from the response headers.
 *
 * Falls back to the array length when the header is absent, and that is
 * correct rather than a compromise: a knowledge build without the header is a
 * knowledge build without the `LIMIT`, so the array IS every row and its
 * length IS the total. The fallback holds exactly in the case it applies to.
 */

async function proxyGet(path: string, params?: Record<string, string>): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' }, total: null };
  }

  const url = new URL(`${AKM_SERVICE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
      },
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' }, total: null };
  }

  const data = await readBody(resp);
  return { status: resp.status, data, total: totalFrom(resp, data) };
}

export async function listAgents(): Promise<ProxyResponse> {
  return proxyGet('/internal/admin/agents');
}

export interface PageOpts {
  limit?: number;
  offset?: number;
}

export async function listEntries(
  agentId: string,
  type?: string,
  page?: PageOpts,
): Promise<ProxyResponse> {
  const params: Record<string, string> = { agent_id: agentId };
  if (type) params.type = type;
  if (page?.limit !== undefined) params.limit = String(page.limit);
  if (page?.offset !== undefined) params.offset = String(page.offset);
  return proxyGet('/internal/admin/entries', params);
}

export async function readEntry(agentId: string, path: string): Promise<ProxyResponse> {
  return proxyGet(`/internal/admin/entries/${encodeURIComponent(agentId)}/${path}`);
}

export async function searchEntries(q: string, agentId?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = { q };
  if (agentId) params.agent_id = agentId;
  return proxyGet('/internal/admin/search', params);
}

export async function createEntry(agentId: string, path: string, content: string): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' }, total: null };
  }

  const url = `${AKM_SERVICE_URL}/internal/admin/entries/${encodeURIComponent(agentId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, content }),
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' }, total: null };
  }

  const data = await readBody(resp);
  return { status: resp.status, data, total: totalFrom(resp, data) };
}

export async function appendJournal(agentId: string, content: string): Promise<ProxyResponse> {
  if (!AKM_INTERNAL_SERVICE_TOKEN) {
    return { status: 503, data: { error: 'Knowledge service not configured' }, total: null };
  }

  const url = `${AKM_SERVICE_URL}/internal/admin/journal/${encodeURIComponent(agentId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' }, total: null };
  }

  const data = await readBody(resp);
  return { status: resp.status, data, total: totalFrom(resp, data) };
}
