import type {
  AppSession,
  AppUser,
  AuditEntry,
  LoginResponse,
  MeResponse,
  PermissionAssignment,
  QrTokenResponse,
  SystemStatus,
} from "../types/nas";

export const getApiBaseUrl = () => {
  const currentHost = window.location.hostname;
  const host =
    !currentHost || currentHost === "tauri.localhost" || currentHost === "localhost"
      ? "localhost"
      : currentHost;
  return `http://${host}:14201`;
};

const TOKEN_STORAGE_KEY = "telegram_drive_access_token";

export const nasSession = {
  getAccessToken: () => localStorage.getItem(TOKEN_STORAGE_KEY),
  setAccessToken: (token: string) => localStorage.setItem(TOKEN_STORAGE_KEY, token),
  clearAccessToken: () => localStorage.removeItem(TOKEN_STORAGE_KEY),
};

async function request<T>(path: string, init: RequestInit = {}, csrfToken?: string): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const accessToken = nasSession.getAccessToken();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

export const nasApi = {
  systemStatus: () => request<SystemStatus>("/api/system/status"),
  bootstrap: (payload: { username: string; password: string; display_name: string }) =>
    request<LoginResponse>("/api/admin/bootstrap", { method: "POST", body: JSON.stringify(payload) }),
  login: (payload: { username: string; password: string }) =>
    request<LoginResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: (csrfToken?: string) =>
    request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }, csrfToken),
  me: () => request<MeResponse>("/api/auth/me"),
  redeemQr: (token: string) => request<LoginResponse>(`/api/auth/qr/redeem/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify({}) }),
  listUsers: () => request<AppUser[]>("/api/admin/users"),
  createUser: (payload: { username: string; password: string; display_name: string; disabled: boolean; role: "admin" | "user" }, csrfToken: string) =>
    request<AppUser>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  updateUser: (userId: string, payload: Record<string, unknown>, csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) }, csrfToken),
  deleteUser: (userId: string, csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}`, { method: "DELETE" }, csrfToken),
  listSessions: () => request<AppSession[]>("/api/admin/sessions"),
  revokeSession: (sessionId: string, csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/sessions/${sessionId}`, { method: "DELETE" }, csrfToken),
  generateQr: (userId: string, csrfToken: string) =>
    request<QrTokenResponse>(`/api/admin/users/${userId}/qr`, { method: "POST", body: JSON.stringify({}) }, csrfToken),
  revokeQr: (userId: string, csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/qr`, { method: "DELETE" }, csrfToken),
  getPermissions: (userId: string) =>
    request<PermissionAssignment[]>(`/api/admin/users/${userId}/permissions`),
  setPermissions: (userId: string, permissions: PermissionAssignment[], csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/permissions`, { method: "PUT", body: JSON.stringify({ permissions }) }, csrfToken),
  ownerStatus: () => request<{ configured: boolean; api_id?: string; connected: boolean }>("/api/admin/owner/status"),
  saveOwnerConfig: (payload: { api_id: number; api_hash: string }, csrfToken: string) =>
    request<{ ok: boolean }>("/api/admin/owner/config", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  listAuditLogs: () => request<AuditEntry[]>("/api/admin/audit-logs"),
};
