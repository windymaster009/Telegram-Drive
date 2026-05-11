import type {
  AppSession,
  AppUser,
  AuthResult,
  AuditEntry,
  LoginResponse,
  MeResponse,
  PermissionAssignment,
  QrTokenResponse,
  SystemStatus,
} from "@shared/nas";
import type { TelegramFile, TelegramFolder } from "@shared/telegram";

export const getApiBaseUrl = () => {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/$/, "");

  const currentHost = window.location.hostname;
  const host =
    !currentHost || currentHost === "tauri.localhost" || currentHost === "localhost"
      ? "localhost"
      : currentHost;
  return `http://${host}:14201`;
};

const TOKEN_STORAGE_KEY = "telegram_drive_access_token";
const CSRF_STORAGE_KEY = "telegram_drive_csrf_token";

export type GoogleDesktopLoginStatus =
  | { status: "pending" }
  | { status: "error"; error: string }
  | { status: "complete"; response: LoginResponse };

export const nasSession = {
  getAccessToken: () => localStorage.getItem(TOKEN_STORAGE_KEY),
  setAccessToken: (token: string) => localStorage.setItem(TOKEN_STORAGE_KEY, token),
  clearAccessToken: () => localStorage.removeItem(TOKEN_STORAGE_KEY),
  getCsrfToken: () => localStorage.getItem(CSRF_STORAGE_KEY),
  setCsrfToken: (token: string) => localStorage.setItem(CSRF_STORAGE_KEY, token),
  clearCsrfToken: () => localStorage.removeItem(CSRF_STORAGE_KEY),
};

async function request<T>(path: string, init: RequestInit = {}, csrfToken?: string): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  const csrf = csrfToken || nasSession.getCsrfToken();
  if (csrf) headers.set("x-csrf-token", csrf);
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

async function requestWithTimeout<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
  timeoutMs = 65000
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<T>(path, { ...init, signal: controller.signal }, csrfToken);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out. Check the Pi backend logs and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export const nasApi = {
  systemStatus: () => request<SystemStatus>("/api/system/status"),
  bootstrap: (payload: { username: string; password: string; display_name: string }) =>
    request<LoginResponse>("/api/admin/bootstrap", { method: "POST", body: JSON.stringify(payload) }),
  googleLogin: (payload: { code: string; redirect_uri?: string }) =>
    request<LoginResponse>("/api/auth/google", { method: "POST", body: JSON.stringify(payload) }),
  googleDesktopComplete: (payload: { code: string; state: string; redirect_uri?: string }) =>
    request<{ ok: boolean }>("/api/auth/google/desktop/complete", { method: "POST", body: JSON.stringify(payload) }),
  googleDesktopStatus: (state: string) =>
    request<GoogleDesktopLoginStatus>(`/api/auth/google/desktop/status/${encodeURIComponent(state)}`),
  login: (payload: { username: string; password: string }) =>
    request<LoginResponse>("/api/auth/login", { method: "POST", body: JSON.stringify(payload) }),
  logout: (csrfToken?: string) =>
    request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }, csrfToken),
  me: () => request<MeResponse>("/api/auth/me"),
  telegramConnection: () => request<{ connected: boolean }>("/api/telegram/connection"),
  streamUrl: (folderId: number | null, messageId: number) => {
    const folder = folderId === null ? "home" : String(folderId);
    const params = new URLSearchParams();
    const accessToken = nasSession.getAccessToken();
    if (accessToken) params.set("access_token", accessToken);
    return `${getApiBaseUrl()}/api/telegram/stream/${encodeURIComponent(folder)}/${encodeURIComponent(String(messageId))}?${params.toString()}`;
  },
  listTelegramFiles: (folderId: number | null) => {
    const params = new URLSearchParams();
    if (folderId !== null) params.set("folder_id", String(folderId));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<TelegramFile[]>(`/api/telegram/files${suffix}`);
  },
  scanTelegramFolders: () => request<TelegramFolder[]>("/api/telegram/folders/scan"),
  createTelegramFolder: (name: string) =>
    request<TelegramFolder>("/api/telegram/folders", { method: "POST", body: JSON.stringify({ name }) }),
  deleteTelegramFolder: (folderId: number) =>
    request<{ ok: boolean }>(`/api/telegram/folders/${folderId}`, { method: "DELETE" }),
  renameTelegramFolder: (folderId: number, name: string) =>
    request<TelegramFolder>(`/api/telegram/folders/${folderId}/name`, { method: "PUT", body: JSON.stringify({ name }) }),
  setTelegramFolderIcon: (folderId: number, icon: string | null) =>
    request<TelegramFolder>(`/api/telegram/folders/${folderId}/icon`, { method: "PUT", body: JSON.stringify({ icon }) }),
  setTelegramFolderPassword: (folderId: number, payload: { password?: string; remove_password?: boolean }) =>
    request<{ ok: boolean }>(`/api/telegram/folders/${folderId}/password`, { method: "PUT", body: JSON.stringify(payload) }),
  verifyTelegramFolderPassword: (folderId: number, password: string) =>
    request<{ ok: boolean }>(`/api/telegram/folders/${folderId}/verify-password`, { method: "POST", body: JSON.stringify({ password }) }),
  deleteTelegramFile: (messageId: number, folderId: number | null) => {
    const params = new URLSearchParams();
    if (folderId !== null) params.set("folder_id", String(folderId));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{ ok: boolean }>(`/api/telegram/files/${messageId}${suffix}`, { method: "DELETE" });
  },
  moveTelegramFiles: (payload: { message_ids: number[]; source_folder_id: number | null; target_folder_id: number | null }) =>
    request<{ ok: boolean }>("/api/telegram/files/move", { method: "POST", body: JSON.stringify(payload) }),
  copyTelegramFiles: (payload: { message_ids: number[]; source_folder_id: number | null; target_folder_id: number | null }) =>
    request<{ ok: boolean }>("/api/telegram/files/copy", { method: "POST", body: JSON.stringify(payload) }),
  searchTelegramFiles: (query: string) => {
    const params = new URLSearchParams({ query });
    return request<TelegramFile[]>(`/api/telegram/search?${params.toString()}`);
  },
  requestQr: (payload: { identifier: string }) =>
    request<QrTokenResponse>("/api/auth/qr/request", { method: "POST", body: JSON.stringify(payload) }),
  qrStatus: (token: string) =>
    request<{ approved: boolean; expired: boolean }>(`/api/auth/qr/status/${encodeURIComponent(token)}`),
  redeemQr: (token: string) => request<LoginResponse>(`/api/auth/qr/redeem/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify({}) }),
  listUsers: () => request<AppUser[]>("/api/admin/users"),
  createUser: (payload: { username: string; password: string; display_name: string; telegram_username?: string; disabled: boolean; role: "admin" | "user" }, csrfToken: string) =>
    request<AppUser>("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  updateUser: (userId: string, payload: Record<string, unknown>, csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) }, csrfToken),
  setUserApproval: (userId: string, approval_status: "pending" | "approved" | "rejected", csrfToken: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${userId}/approval`, { method: "PUT", body: JSON.stringify({ approval_status }) }, csrfToken),
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
  ownerStatus: () => request<{ configured: boolean; api_id?: string | null; connected: boolean; error?: string | null }>("/api/admin/owner/status"),
  saveOwnerConfig: (payload: { api_id: number; api_hash: string }, csrfToken: string) =>
    request<{ ok: boolean }>("/api/admin/owner/config", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  requestOwnerCode: (payload: { phone: string }, csrfToken: string) =>
    requestWithTimeout<{ status: string }>("/api/admin/owner/auth/request-code", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  ownerSignIn: (payload: { code: string }, csrfToken: string) =>
    request<AuthResult>("/api/admin/owner/auth/sign-in", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  ownerCheckPassword: (payload: { password: string }, csrfToken: string) =>
    request<AuthResult>("/api/admin/owner/auth/check-password", { method: "POST", body: JSON.stringify(payload) }, csrfToken),
  ownerLogout: (csrfToken: string) =>
    request<{ ok: boolean }>("/api/admin/owner/auth/logout", { method: "POST", body: JSON.stringify({}) }, csrfToken),
  clearOwnerConfig: (csrfToken: string) =>
    request<{ ok: boolean }>("/api/admin/owner/config", { method: "DELETE" }, csrfToken),
  listAuditLogs: () => request<AuditEntry[]>("/api/admin/audit-logs"),
};
