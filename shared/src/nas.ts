export type AppRole = "admin" | "user";
export type AccessLevel = "read_only" | "read_write";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface SystemStatus {
  setup_required: boolean;
  owner_configured: boolean;
  owner_connected: boolean;
  api_base_url: string;
}

export interface AppUser {
  id: string;
  username: string;
  display_name: string;
  telegram_username?: string | null;
  google_id?: string | null;
  email?: string | null;
  avatar?: string | null;
  role: AppRole;
  disabled: boolean;
  approval_status: ApprovalStatus;
  is_approved: boolean;
  created_at: number;
}

export interface PermissionAssignment {
  folder_id: string;
  folder_label: string;
  access_level: AccessLevel;
  is_private: boolean;
  owner_id?: string | null;
  owner_name?: string | null;
  icon?: string | null;
  is_password_protected?: boolean;
  can_manage?: boolean;
}

export interface MeResponse {
  user: AppUser;
  permissions: PermissionAssignment[];
  owner_connected: boolean;
  csrf_token: string;
}

export interface LoginResponse {
  user: AppUser;
  csrf_token: string;
  access_token: string;
}

export interface AppSession {
  id: string;
  user_id: string;
  username: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string;
  ip_address: string;
}

export interface QrTokenResponse {
  token: string;
  login_url: string;
  expires_at: number;
  user_id: string;
}

export interface AuditEntry {
  id: string;
  actor_user_id?: string | null;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: number;
}
