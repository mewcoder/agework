import { useAuthStore } from '@/stores/auth-store';
import { normalizeBasePath } from '@/utils/path';
import type { ApiResponse } from '@agework/shared';

let unauthorizedHandler: (() => void) | undefined;

const API_PATH = '/api/v1';
const apiContext = normalizeBasePath(import.meta.env.VITE_APP_API_CONTEXT);
const apiBasePath = apiContext ? `${apiContext}${API_PATH}` : API_PATH;

export function apiUrl(path: string): string {
  if (/^[a-z][a-z\d+\-.]*:/i.test(path) || path.startsWith('//')) return path;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (normalizedPath === API_PATH || normalizedPath.startsWith(`${API_PATH}/`)) {
    return `${apiBasePath}${normalizedPath.slice(API_PATH.length)}`;
  }

  if (normalizedPath === '/api' || normalizedPath.startsWith('/api/')) return normalizedPath;

  return path;
}

export function setUnauthorizedHandler(handler: () => void) {
  unauthorizedHandler = handler;
}

function errorDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const message = obj.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message)) {
    const messages = message.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    if (messages.length > 0) return messages.join('\n');
  }
  const error = obj.error;
  if (typeof error === 'string' && error.trim()) return error;
  return undefined;
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch((e: unknown) => {
      console.error('[http] failed to parse response JSON:', e);
      return undefined;
    });
  }
  return response.text().catch((e: unknown) => {
    console.error('[http] failed to read response text:', e);
    return undefined;
  });
}

async function requestError(response: Response): Promise<Error> {
  const body = await responseBody(response);
  const detail = errorDetail(body) ?? (typeof body === 'string' && body.trim() ? body : undefined);
  return new Error(detail ?? `${response.status} ${response.statusText}`);
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handle401(response: Response) {
  if (response.status === 401 && useAuthStore.getState().authRequired) {
    useAuthStore.getState().logout();
    unauthorizedHandler?.();
  }
}

export function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => { result[k] = v; });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) result[k] = v;
  } else {
    Object.assign(result, headers);
  }
  return result;
}

async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(
    typeof input === 'string' ? apiUrl(input) : input,
    {
      ...init,
      headers: {
        ...authHeaders(),
        ...normalizeHeaders(init?.headers),
      },
    },
  );
  if (!response.ok) {
    handle401(response);
    throw await requestError(response);
  }
  return response;
}

function unwrap<T>(json: unknown): T {
  if (
    typeof json === 'object' &&
    json !== null &&
    'code' in json &&
    'data' in json
  ) {
    const env = json as ApiResponse<T>;
    if (env.code !== 0) throw new Error(env.message || 'Server error');
    return env.data;
  }
  return json as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  const r = await doFetch(url);
  const json = await r.json().catch((e: unknown) => {
    throw new Error(`Failed to parse response JSON: ${e}`);
  });
  return unwrap<T>(json);
}

export async function apiPost<T = void>(url: string, body?: unknown): Promise<T> {
  const r = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const contentType = r.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined as T;
  const json = await r.json();
  return unwrap<T>(json);
}
