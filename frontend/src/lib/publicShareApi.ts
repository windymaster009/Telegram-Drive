import type { TelegramFile } from '@shared/telegram';
import { getApiBaseUrl, nasSession } from './nasApi';

export type PublicShareKind = 'file' | 'folder';

export type PublicShareCreateResult = {
  token: string;
  kind: PublicShareKind;
  label: string;
  expires_at: number | null;
};

export type PublicShareView = {
  kind: PublicShareKind;
  label: string;
  expires_at: number | null;
  file: TelegramFile | null;
  files: TelegramFile[];
};

export type CreatePublicSharePayload = {
  kind: PublicShareKind;
  folder_id: number | null;
  message_id?: number | null;
  label?: string;
  expires_at: number | null;
};

async function authenticatedRequest<T>(path: string, init: RequestInit): Promise<T> {
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

async function publicRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const publicShareApi = {
  create: (payload: CreatePublicSharePayload) =>
    authenticatedRequest<PublicShareCreateResult>('/api/shares', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  revoke: (token: string) =>
    authenticatedRequest<{ ok: boolean }>(`/api/shares/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    }),

  get: (token: string) =>
    publicRequest<PublicShareView>(`/api/public/shares/${encodeURIComponent(token)}`),

  mediaUrl: (token: string, messageId: number, download = false) => {
    const params = new URLSearchParams();
    if (download) params.set('download', 'true');
    const query = params.toString();
    return `${getApiBaseUrl()}/api/public/shares/${encodeURIComponent(token)}/media/${encodeURIComponent(String(messageId))}${query ? `?${query}` : ''}`;
  },
};
