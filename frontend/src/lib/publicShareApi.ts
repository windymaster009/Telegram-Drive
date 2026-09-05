import type { TelegramFile } from '@shared/telegram';
import { getApiBaseUrl, nasSession } from './nasApi';

export type PublicShareKind = 'file' | 'folder';
export type PublicShareStatus = 'active' | 'expired' | 'revoked';

export type PublicShareCreateResult = {
  token: string;
  kind: PublicShareKind;
  label: string;
  expires_at: number | null;
  has_password: boolean;
};

export type PublicShareView = {
  kind: PublicShareKind;
  label: string;
  expires_at: number | null;
  file: TelegramFile | null;
  files: TelegramFile[];
};

export type PublicShareAdminEntry = {
  token: string;
  kind: PublicShareKind;
  folder_id: number | null;
  message_id: number | null;
  label: string;
  created_by: string;
  created_by_name: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  status: PublicShareStatus;
  views: number;
  downloads: number;
  last_accessed_at: number | null;
  has_password: boolean;
};

export type CreatePublicSharePayload = {
  kind: PublicShareKind;
  folder_id: number | null;
  message_id?: number | null;
  label?: string;
  expires_at: number | null;
  password?: string;
  remove_password?: boolean;
};

export type UpdatePublicSharePayload = {
  expires_at: number | null;
  password?: string;
  remove_password?: boolean;
};

export class PublicSharePasswordRequiredError extends Error {
  readonly expiresAt: number | null;

  constructor(expiresAt: number | null) {
    super('Password required');
    this.name = 'PublicSharePasswordRequiredError';
    this.expiresAt = expiresAt;
  }
}

async function authenticatedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  const accessToken = nasSession.getAccessToken();
  const csrf = nasSession.getCsrfToken();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (csrf) headers.set('x-csrf-token', csrf);

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    credentials: 'omit',
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) {
    if (response.status === 401 && body.password_required) {
      throw new PublicSharePasswordRequiredError(body.expires_at ?? null);
    }
    throw new Error(body.error || response.statusText);
  }
  return body as T;
}

async function publicPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
  });
  const body = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body as T;
}

function accessQuery(accessKey?: string | null) {
  const params = new URLSearchParams();
  if (accessKey) params.set('access_key', accessKey);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const publicShareApi = {
  create: (payload: CreatePublicSharePayload) =>
    authenticatedRequest<PublicShareCreateResult>('/api/share-links', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  list: () => authenticatedRequest<PublicShareAdminEntry[]>('/api/share-links'),

  update: (token: string, payload: UpdatePublicSharePayload) =>
    authenticatedRequest<PublicShareCreateResult>(`/api/share-links/${encodeURIComponent(token)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  revoke: (token: string) =>
    authenticatedRequest<{ ok: boolean }>(`/api/share-links/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    }),

  get: (token: string, accessKey?: string | null) =>
    publicGet<PublicShareView>(`/api/public/share-links/${encodeURIComponent(token)}${accessQuery(accessKey)}`),

  unlock: (token: string, password: string) =>
    publicPost<{ access_key: string; expires_at: number }>(
      `/api/public/share-links/${encodeURIComponent(token)}/unlock`,
      { password },
    ),

  mediaUrl: (token: string, messageId: number, download = false, accessKey?: string | null) => {
    const params = new URLSearchParams();
    if (download) params.set('download', 'true');
    if (accessKey) params.set('access_key', accessKey);
    const query = params.toString();
    return `${getApiBaseUrl()}/api/public/share-links/${encodeURIComponent(token)}/media/${encodeURIComponent(String(messageId))}${query ? `?${query}` : ''}`;
  },
};
