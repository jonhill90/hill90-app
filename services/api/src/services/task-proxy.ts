/**
 * HTTP client for proxying task requests to the knowledge service's
 * internal admin task endpoints. Authenticated with AKM_INTERNAL_SERVICE_TOKEN.
 */

import { totalFrom } from '../helpers/upstream-total';

const AKM_SERVICE_URL = process.env.AKM_SERVICE_URL || 'http://knowledge:8002';
const AKM_INTERNAL_SERVICE_TOKEN = process.env.AKM_INTERNAL_SERVICE_TOKEN;

export interface ProxyResponse {
  status: number;
  data: unknown;
  /**
   * The real row count upstream, from `X-Total-Count` — NOT `data.length`.
   *
   * `list_tasks` bounds at 500 by default (`internal_admin_tasks.py`) and this
   * proxy never overrides that, so a board with more than 500 tasks was
   * silently cut with nothing to say so: `TaskBoardClient` rendered
   * `tasks.length` as if it were the count of every task, agreeing with
   * itself in exactly the shape #180 and #215 already named. `totalFrom` is
   * reused rather than reimplemented — see its own header comment for why a
   * second copy of "a page length is not a total" is the defect, not a fix.
   */
  total: number | null;
}

async function proxyRequest(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown,
): Promise<ProxyResponse> {
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

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${AKM_INTERNAL_SERVICE_TOKEN}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { status: 502, data: { error: 'Knowledge service unavailable' }, total: null };
  }

  const data = await resp.json();
  return { status: resp.status, data, total: totalFrom(resp, data) };
}

export async function listTasks(agentId?: string, status?: string): Promise<ProxyResponse> {
  const params: Record<string, string> = {};
  if (agentId) params.agent_id = agentId;
  if (status) params.status = status;
  return proxyRequest('GET', '/internal/admin/tasks', params);
}

export async function getTask(taskId: string): Promise<ProxyResponse> {
  return proxyRequest('GET', `/internal/admin/tasks/${taskId}`);
}

export async function createTask(body: {
  agent_id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  tags?: string[];
  created_by: string;
}): Promise<ProxyResponse> {
  return proxyRequest('POST', '/internal/admin/tasks', undefined, body);
}

export async function updateTask(taskId: string, body: {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  tags?: string[];
}): Promise<ProxyResponse> {
  return proxyRequest('PUT', `/internal/admin/tasks/${taskId}`, undefined, body);
}

export async function transitionTask(taskId: string, status: string): Promise<ProxyResponse> {
  return proxyRequest('PATCH', `/internal/admin/tasks/${taskId}/transition`, undefined, { status });
}

export async function cancelTask(taskId: string): Promise<ProxyResponse> {
  return proxyRequest('DELETE', `/internal/admin/tasks/${taskId}`);
}
