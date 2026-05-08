import { FormEvent, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Shield, UserPlus, Users, History, KeyRound, ScanQrCode, HardDrive, LogOut } from "lucide-react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Dashboard } from "./components/Dashboard";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { nasApi, nasSession } from "./lib/nasApi";
import { ConfirmProvider } from "./context/ConfirmContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { DropZoneProvider } from "./contexts/DropZoneContext";
import { Toaster, toast } from "sonner";
import type {
  AppSession,
  AppUser,
  AuditEntry,
  MeResponse,
  PermissionAssignment,
  QrTokenResponse,
  SystemStatus,
} from "./types/nas";
import type { TelegramFolder } from "./types";
import "./App.css";

const queryClient = new QueryClient();

function AppContent() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const { theme } = useTheme();
  const { available, version, downloading, progress, downloadAndInstall, dismissUpdate } = useUpdateCheck();
  const client = useQueryClient();
  const qrToken = useMemo(() => new URLSearchParams(window.location.search).get("qr"), []);

  const systemQuery = useQuery({
    queryKey: ["system-status"],
    queryFn: nasApi.systemStatus,
    retry: false,
  });

  const meQuery = useQuery({
    queryKey: ["auth-me"],
    queryFn: nasApi.me,
    retry: false,
    enabled: !systemQuery.data?.setup_required,
  });

  const finishLogin = (response: { csrf_token: string; access_token: string }) => {
    nasSession.setAccessToken(response.access_token);
    setCsrfToken(response.csrf_token);
    client.invalidateQueries({ queryKey: ["auth-me"] });
    client.invalidateQueries({ queryKey: ["system-status"] });
  };

  const handleLogout = async () => {
    try {
      await nasApi.logout(csrfToken || undefined);
    } finally {
      nasSession.clearAccessToken();
      setCsrfToken(null);
      client.removeQueries({ queryKey: ["auth-me"] });
      client.invalidateQueries({ queryKey: ["system-status"] });
    }
  };

  useEffect(() => {
    if (qrToken && !meQuery.data && !systemQuery.data?.setup_required) {
      nasApi
        .redeemQr(qrToken)
        .then((response) => {
          finishLogin(response);
          window.history.replaceState({}, "", window.location.pathname);
          toast.success("QR login complete");
        })
        .catch((error) => {
          toast.error(error.message || "QR login failed");
        });
    }
  }, [qrToken, meQuery.data, systemQuery.data?.setup_required]);

  useEffect(() => {
    if (meQuery.data?.csrf_token) {
      setCsrfToken(meQuery.data.csrf_token);
    }
  }, [meQuery.data?.csrf_token]);

  const isLoading = systemQuery.isLoading || (meQuery.isLoading && !systemQuery.data?.setup_required);

  return (
    <main className="h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_#142238,_#08101d_55%,_#050810)] text-white">
      <UpdateBanner
        available={available}
        version={version}
        downloading={downloading}
        progress={progress}
        onUpdate={downloadAndInstall}
        onDismiss={dismissUpdate}
      />
      <Toaster theme={theme} position="bottom-center" />

      {isLoading ? (
        <CenteredCard title="Preparing Telegram NAS" subtitle="Loading the auth and owner-session state..." />
      ) : systemQuery.error ? (
        <CenteredCard title="Backend Unavailable" subtitle={(systemQuery.error as Error).message} />
      ) : systemQuery.data?.setup_required ? (
        <BootstrapPage onBootstrapped={finishLogin} />
      ) : !meQuery.data ? (
        <LoginPage onLoggedIn={finishLogin} qrToken={qrToken} />
      ) : meQuery.data.user.role === "admin" ? (
        <AdminConsole
          csrfToken={csrfToken}
          me={meQuery.data}
          systemStatus={systemQuery.data!}
          onLogout={handleLogout}
        />
      ) : (
        <UserHome me={meQuery.data} onLogout={handleLogout} />
      )}
    </main>
  );
}

function CenteredCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[32px] border border-white/10 bg-white/6 p-10 backdrop-blur-xl">
        <div className="mb-4 inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300">
          <Shield className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-slate-300">{subtitle}</p>
      </div>
    </div>
  );
}

function BootstrapPage({ onBootstrapped }: { onBootstrapped: (response: { csrf_token: string; access_token: string }) => void }) {
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("NAS Owner");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await nasApi.bootstrap({
        username,
        password,
        display_name: displayName,
      });
      onBootstrapped(response);
      toast.success("Admin account created");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-3xl rounded-[36px] border border-white/10 bg-black/25 p-8 shadow-2xl backdrop-blur-2xl">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="mb-3 text-xs uppercase tracking-[0.32em] text-cyan-300">First Launch</p>
            <h1 className="text-4xl font-semibold tracking-tight">Bootstrap the self-hosted Telegram NAS</h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-slate-300">
              This one-time wizard creates the local admin account. Telegram owner credentials are configured later inside the protected admin console, not on the public login screen.
            </p>
          </div>
          <div className="space-y-4 rounded-[28px] border border-white/8 bg-white/5 p-6">
            <Field label="Admin username" value={username} onChange={setUsername} />
            <Field label="Display name" value={displayName} onChange={setDisplayName} />
            <Field label="Password" type="password" value={password} onChange={setPassword} />
            <button disabled={loading} className="w-full rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60">
              {loading ? "Creating admin..." : "Create Admin"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function LoginPage({
  onLoggedIn,
  qrToken,
}: {
  onLoggedIn: (response: { csrf_token: string; access_token: string }) => void;
  qrToken: string | null;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showQrLogin, setShowQrLogin] = useState(Boolean(qrToken));
  const [qrInput, setQrInput] = useState(qrToken || "");
  const [qrIdentifier, setQrIdentifier] = useState("");
  const [publicQr, setPublicQr] = useState<QrTokenResponse | null>(null);
  const [lanIp, setLanIp] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const response = await nasApi.login({ username, password });
      onLoggedIn(response);
      toast.success("Signed in");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const redeemQrInput = async () => {
    const token = extractQrToken(qrInput);
    if (!token) {
      toast.error("Paste a QR token or login link first");
      return;
    }

    setLoading(true);
    try {
      const response = await nasApi.redeemQr(token);
      onLoggedIn(response);
      toast.success("QR login complete");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const requestPublicQr = async () => {
    if (!qrIdentifier.trim()) {
      toast.error("Enter your app username or Telegram username first");
      return;
    }

    setLoading(true);
    try {
      const response = await nasApi.requestQr({ identifier: qrIdentifier });
      setPublicQr(response);
      setQrInput(response.token);
      toast.success("QR ready to scan");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    invoke<string>("cmd_get_lan_ip")
      .then(setLanIp)
      .catch(() => setLanIp(""));
  }, []);

  useEffect(() => {
    if (!publicQr) return;

    const timer = window.setInterval(async () => {
      try {
        const status = await nasApi.qrStatus(publicQr.token);
        if (status.expired) {
          window.clearInterval(timer);
          setPublicQr(null);
          toast.error("QR expired. Generate a new one.");
          return;
        }
        if (status.approved) {
          window.clearInterval(timer);
          const response = await nasApi.redeemQr(publicQr.token);
          onLoggedIn(response);
          toast.success("QR login complete");
        }
      } catch {
        // Keep polling until the QR expires or is approved.
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [publicQr, onLoggedIn]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-[36px] border border-white/10 bg-white/6 p-8 backdrop-blur-xl">
          <p className="mb-3 text-xs uppercase tracking-[0.32em] text-cyan-300">Access Portal</p>
          <h1 className="text-4xl font-semibold tracking-tight">Internal app authentication only</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">
            Users sign into this NAS directly. Telegram API ID, API Hash, and MTProto login are reserved for the owner’s secure admin console.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Feature icon={Users} title="Multi-user roles" copy="Admin and user access is split cleanly from the shared Telegram owner session." />
            <Feature icon={ScanQrCode} title="QR login" copy="Provision mobile access with revokable short-lived QR tokens instead of sharing credentials." />
          </div>
        </div>
        <form onSubmit={handleSubmit} className="rounded-[36px] border border-white/10 bg-black/25 p-8 backdrop-blur-2xl">
          <Field label="Username" value={username} onChange={setUsername} />
          <Field label="Password" type="password" value={password} onChange={setPassword} />
          <button disabled={loading} className="mt-4 w-full rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60">
            {loading ? "Signing in..." : "Sign In"}
          </button>
          <button
            type="button"
            onClick={() => setShowQrLogin((value) => !value)}
            className="mt-3 w-full rounded-2xl border border-white/10 px-4 py-3 text-sm text-slate-200 transition hover:bg-white/8"
          >
            <span className="inline-flex items-center justify-center gap-2"><ScanQrCode className="h-4 w-4" /> Login with QR</span>
          </button>
          {showQrLogin && (
            <div className="mt-4 rounded-3xl border border-cyan-300/20 bg-cyan-300/8 p-4">
              <p className="text-sm font-medium text-white">Scan a QR with your phone</p>
              <p className="mt-2 text-xs leading-5 text-slate-300">
                Enter your app username or saved Telegram username, generate a QR, then scan it on your phone to approve this desktop login.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  value={qrIdentifier}
                  onChange={(event) => setQrIdentifier(event.target.value)}
                  placeholder="@telegramuser or app username"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none transition focus:border-cyan-300/60"
                />
                <button
                  type="button"
                  onClick={requestPublicQr}
                  disabled={loading}
                  className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60"
                >
                  Show QR
                </button>
              </div>
              {publicQr && (
                <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-col items-center gap-3">
                    <QRCodeSVG value={buildQrApprovalUrl(publicQr.token, lanIp)} size={190} bgColor="#ffffff" fgColor="#020617" />
                    <p className="text-center text-xs leading-5 text-slate-300">
                      Waiting for scan. Expires {formatRelativeExpiry(publicQr.expires_at)}.
                    </p>
                    {!lanIp && (
                      <p className="text-center text-xs leading-5 text-amber-200">
                        Could not detect a LAN IP. If your phone cannot open the QR, paste the token below instead.
                      </p>
                    )}
                  </div>
                </div>
              )}
              <p className="mt-4 text-xs leading-5 text-slate-400">Already have an admin-issued QR token or link?</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  value={qrInput}
                  onChange={(event) => setQrInput(event.target.value)}
                  placeholder="Paste QR token or login link"
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm outline-none transition focus:border-cyan-300/60"
                />
                <button
                  type="button"
                  onClick={redeemQrInput}
                  disabled={loading}
                  className="rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60"
                >
                  Redeem
                </button>
              </div>
              {qrToken && <p className="mt-3 text-xs text-cyan-200">A QR token was detected in the URL. The app is trying that flow automatically.</p>}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function AdminConsole({
  csrfToken,
  me,
  systemStatus,
  onLogout,
}: {
  csrfToken: string | null;
  me: MeResponse;
  systemStatus: SystemStatus;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<"owner" | "users" | "sessions" | "audit" | "storage">("owner");
  const tabs = [
    { id: "owner", label: "Owner Session", icon: KeyRound },
    { id: "users", label: "Users", icon: Users },
    { id: "sessions", label: "Sessions", icon: History },
    { id: "audit", label: "Audit", icon: Shield },
    { id: "storage", label: "Storage", icon: HardDrive },
  ] as const;

  if (tab === "storage") {
    return (
      <Dashboard
        onLogout={onLogout}
        adminControls={{ onAdminBack: () => setTab("owner") }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/10 bg-black/20 px-6 py-4 backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Admin Console</p>
            <h1 className="text-2xl font-semibold">Telegram NAS control plane</h1>
            <p className="mt-1 text-sm text-slate-300">
              Signed in as {me.user.display_name}. Owner Telegram session is {systemStatus.owner_connected ? "connected" : "waiting"}.
            </p>
          </div>
          <button onClick={onLogout} className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/8">
            <span className="inline-flex items-center gap-2"><LogOut className="h-4 w-4" /> Sign Out</span>
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {tabs.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-full px-4 py-2 text-sm transition ${tab === item.id ? "bg-cyan-400 text-slate-950" : "border border-white/10 bg-white/5 text-slate-200 hover:bg-white/8"}`}
            >
              <span className="inline-flex items-center gap-2"><item.icon className="h-4 w-4" /> {item.label}</span>
            </button>
          ))}
        </div>
      </header>

      <section className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "owner" && <OwnerTelegramPanel csrfToken={csrfToken} />}
        {tab === "users" && <UsersPanel csrfToken={csrfToken} />}
        {tab === "sessions" && <SessionsPanel csrfToken={csrfToken} />}
        {tab === "audit" && <AuditPanel />}
      </section>
    </div>
  );
}

function OwnerTelegramPanel({ csrfToken }: { csrfToken: string | null }) {
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"config" | "code" | "password">("config");
  const ownerStatus = useQuery({
    queryKey: ["owner-status"],
    queryFn: nasApi.ownerStatus,
    retry: false,
  });

  useEffect(() => {
    if (ownerStatus.data?.api_id) {
      setApiId(ownerStatus.data.api_id);
    }
  }, [ownerStatus.data?.api_id]);

  const saveOwnerConfig = async () => {
    if (!csrfToken) return;
    await nasApi.saveOwnerConfig({ api_id: Number(apiId), api_hash: apiHash }, csrfToken);
  };

  const requestCode = async () => {
    try {
      await saveOwnerConfig();
      await invoke("cmd_auth_request_code", { phone, apiId: Number(apiId), apiHash });
      setStep("code");
      toast.success("Telegram code requested");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const completeCode = async () => {
    try {
      const response = await invoke<{ success: boolean; next_step?: string }>("cmd_auth_sign_in", { code });
      if (response.success) {
        toast.success("Owner Telegram session connected");
        ownerStatus.refetch();
      } else if (response.next_step === "password") {
        setStep("password");
      }
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const completePassword = async () => {
    try {
      await invoke("cmd_auth_check_password", { password });
      toast.success("Owner Telegram session connected");
      ownerStatus.refetch();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-[32px] border border-white/10 bg-white/6 p-6">
        <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Owner Session</p>
        <h2 className="mt-2 text-2xl font-semibold">One Telegram account for the whole NAS</h2>
        <p className="mt-4 text-sm leading-7 text-slate-300">
          Configure the owner account once. Normal users never see API credentials or MTProto login prompts.
        </p>
        <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm">
          <p>Configured: <strong>{ownerStatus.data?.configured ? "Yes" : "No"}</strong></p>
          <p>Connected: <strong>{ownerStatus.data?.connected ? "Yes" : "No"}</strong></p>
        </div>
      </div>
      <div className="rounded-[32px] border border-white/10 bg-black/25 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Telegram API ID" value={apiId} onChange={setApiId} />
          <Field label="Telegram API Hash" value={apiHash} onChange={setApiHash} />
          <Field label="Phone number" value={phone} onChange={setPhone} />
          <div className="flex items-end">
            <button onClick={requestCode} className="w-full rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300">
              Save & Request Code
            </button>
          </div>
        </div>
        {step === "code" && (
          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
            <Field label="Telegram code" value={code} onChange={setCode} />
            <div className="flex items-end">
              <button onClick={completeCode} className="rounded-2xl border border-white/10 px-4 py-3 text-sm transition hover:bg-white/8">Verify Code</button>
            </div>
          </div>
        )}
        {step === "password" && (
          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
            <Field label="2FA password" type="password" value={password} onChange={setPassword} />
            <div className="flex items-end">
              <button onClick={completePassword} className="rounded-2xl border border-white/10 px-4 py-3 text-sm transition hover:bg-white/8">Verify Password</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UsersPanel({ csrfToken }: { csrfToken: string | null }) {
  const client = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: nasApi.listUsers, retry: false });
  const [draft, setDraft] = useState<{ username: string; password: string; display_name: string; telegram_username: string; disabled: boolean; role: "admin" | "user" }>({
    username: "",
    password: "",
    display_name: "",
    telegram_username: "",
    disabled: false,
    role: "user",
  });
  const [selectedUser, setSelectedUser] = useState<AppUser | null>(null);
  const [qr, setQr] = useState<QrTokenResponse | null>(null);
  const permissions = useQuery({
    queryKey: ["user-permissions", selectedUser?.id],
    queryFn: () => nasApi.getPermissions(selectedUser!.id),
    enabled: !!selectedUser,
  });
  const folderCatalog = useQuery({
    queryKey: ["telegram-folder-catalog"],
    queryFn: async () => {
      try {
        return await invoke<TelegramFolder[]>("cmd_scan_folders");
      } catch {
        return [];
      }
    },
    enabled: !!selectedUser,
  });
  const [permissionDraft, setPermissionDraft] = useState<PermissionAssignment[]>([]);

  useEffect(() => {
    setPermissionDraft(permissions.data || []);
  }, [permissions.data]);

  const availableFolders = useMemo(
    () => [
      { id: "root", name: "Saved Messages" },
      ...(folderCatalog.data || []).map((folder) => ({
        id: String(folder.id),
        name: folder.name,
      })),
    ],
    [folderCatalog.data]
  );

  const setFolderPermission = (
    folder: { id: string; name: string },
    enabled: boolean,
    accessLevel: PermissionAssignment["access_level"] = "read_write"
  ) => {
    setPermissionDraft((current) => {
      if (!enabled) {
        return current.filter((permission) => permission.folder_id !== folder.id);
      }

      const existing = current.find((permission) => permission.folder_id === folder.id);
      if (existing) {
        return current.map((permission) =>
          permission.folder_id === folder.id
            ? { ...permission, folder_label: folder.name, access_level: accessLevel }
            : permission
        );
      }

      return [
        ...current,
        {
          folder_id: folder.id,
          folder_label: folder.name,
          access_level: accessLevel,
          is_private: false,
        },
      ];
    });
  };

  const refresh = () => {
    client.invalidateQueries({ queryKey: ["admin-users"] });
    if (selectedUser) client.invalidateQueries({ queryKey: ["user-permissions", selectedUser.id] });
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    try {
      await nasApi.createUser(draft, csrfToken);
      setDraft({ username: "", password: "", display_name: "", telegram_username: "", disabled: false, role: "user" });
      refresh();
      toast.success("User created");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const savePermissions = async () => {
    if (!csrfToken || !selectedUser) return;
    try {
      await nasApi.setPermissions(selectedUser.id, permissionDraft, csrfToken);
      refresh();
      toast.success("Permissions updated");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
      <form onSubmit={createUser} className="rounded-[32px] border border-white/10 bg-black/25 p-6">
        <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Create User</p>
        <div className="mt-4 space-y-4">
          <Field label="Username" value={draft.username} onChange={(value) => setDraft((prev) => ({ ...prev, username: value }))} />
          <Field label="Display name" value={draft.display_name} onChange={(value) => setDraft((prev) => ({ ...prev, display_name: value }))} />
          <Field label="Telegram username (optional)" value={draft.telegram_username} onChange={(value) => setDraft((prev) => ({ ...prev, telegram_username: value }))} />
          <Field label="Password" type="password" value={draft.password} onChange={(value) => setDraft((prev) => ({ ...prev, password: value }))} />
          <label className="block text-sm">
            <span className="mb-2 block text-slate-300">Role</span>
            <select value={draft.role} onChange={(event) => setDraft((prev) => ({ ...prev, role: event.target.value as "admin" | "user" }))} className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 outline-none">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="w-full rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300">
            <span className="inline-flex items-center gap-2"><UserPlus className="h-4 w-4" /> Create User</span>
          </button>
        </div>
      </form>

      <div className="space-y-6">
        <div className="rounded-[32px] border border-white/10 bg-white/6 p-6">
          <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Users</p>
          <div className="mt-4 grid gap-3">
            {users.data?.map((user) => (
              <button key={user.id} onClick={() => { setSelectedUser(user); setPermissionDraft([]); setQr(null); }} className="rounded-2xl border border-white/10 bg-black/25 p-4 text-left transition hover:bg-white/8">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{user.display_name}</p>
                    {user.telegram_username && <p className="mt-1 text-xs text-cyan-200">{user.telegram_username}</p>}
                    <p className="text-sm text-slate-300">@{user.username} · {user.role}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs ${user.disabled ? "bg-red-500/20 text-red-200" : "bg-emerald-500/20 text-emerald-200"}`}>
                    {user.disabled ? "Disabled" : "Active"}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {selectedUser && (
          <div className="rounded-[32px] border border-white/10 bg-black/25 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">{selectedUser.display_name}</p>
                <p className="text-sm text-slate-300">@{selectedUser.username}</p>
                {selectedUser.telegram_username && <p className="mt-1 text-sm text-cyan-200">{selectedUser.telegram_username}</p>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    if (!csrfToken) return;
                    const qrResponse = await nasApi.generateQr(selectedUser.id, csrfToken);
                    setQr(qrResponse);
                  }}
                  className="rounded-2xl border border-white/10 px-4 py-2 text-sm transition hover:bg-white/8"
                >
                  Generate QR
                </button>
                <button
                  onClick={async () => {
                    if (!csrfToken) return;
                    await nasApi.revokeQr(selectedUser.id, csrfToken);
                    setQr(null);
                    toast.success("QR tokens revoked");
                  }}
                  className="rounded-2xl border border-white/10 px-4 py-2 text-sm transition hover:bg-white/8"
                >
                  Revoke QR
                </button>
              </div>
            </div>

            {qr && (
              <div className="mt-6 rounded-3xl border border-white/10 bg-white/5 p-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-center">
                  <QRCodeSVG value={buildQrLoginUrl(qr.token)} size={160} bgColor="#ffffff" fgColor="#020617" />
                  <div className="text-sm text-slate-300">
                    <p className="font-medium text-white">Login QR for {selectedUser.display_name}</p>
                    <p className="mt-2">Expires {formatRelativeExpiry(qr.expires_at)}. The QR is single-use and can be revoked.</p>
                    <p className="mt-2 break-all rounded-2xl border border-white/10 bg-black/20 p-3 text-xs">{buildQrLoginUrl(qr.token)}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(buildQrLoginUrl(qr.token)).then(() => toast.success("QR login link copied"))}
                        className="rounded-2xl border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/8"
                      >
                        <span className="inline-flex items-center gap-2"><Copy className="h-3.5 w-3.5" /> Copy link</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(qr.token).then(() => toast.success("QR token copied"))}
                        className="rounded-2xl border border-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/8"
                      >
                        Copy token
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">Folder permissions</p>
                  <p className="mt-2 text-xs leading-6 text-slate-400">
                    Pick the Telegram folders this user can open. Read-write users can upload and move files, but normal users still cannot delete admin-created folders.
                  </p>
                </div>
                <button
                  onClick={() => folderCatalog.refetch()}
                  className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/8"
                >
                  Refresh Folders
                </button>
              </div>

              <div className="mt-4 max-h-80 space-y-3 overflow-auto rounded-3xl border border-white/10 bg-white/5 p-3">
                {availableFolders.map((folder) => {
                  const permission = permissionDraft.find((item) => item.folder_id === folder.id);
                  const enabled = Boolean(permission);

                  return (
                    <div key={folder.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/8 bg-black/20 p-3">
                      <label className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(event) => setFolderPermission(folder, event.target.checked)}
                          className="h-4 w-4 accent-cyan-400"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-white">{folder.name}</span>
                          <span className="block truncate text-xs text-slate-400">{folder.id === "root" ? "Owner Saved Messages" : `Telegram folder ${folder.id}`}</span>
                        </span>
                      </label>
                      <select
                        disabled={!enabled}
                        value={permission?.access_level || "read_write"}
                        onChange={(event) => setFolderPermission(folder, true, event.target.value as PermissionAssignment["access_level"])}
                        className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <option value="read_write">Read + Write</option>
                        <option value="read_only">Read Only</option>
                      </select>
                    </div>
                  );
                })}
                {availableFolders.length === 1 && (
                  <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-400">
                    No Telegram folders found yet. Use Storage as admin to sync or create folders, then refresh this list.
                  </div>
                )}
              </div>

              <button onClick={savePermissions} className="mt-3 rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300">
                Save Permissions
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionsPanel({ csrfToken }: { csrfToken: string | null }) {
  const client = useQueryClient();
  const sessions = useQuery({ queryKey: ["admin-sessions"], queryFn: nasApi.listSessions, retry: false });

  const revoke = async (sessionId: string) => {
    if (!csrfToken) return;
    await nasApi.revokeSession(sessionId, csrfToken);
    client.invalidateQueries({ queryKey: ["admin-sessions"] });
    toast.success("Session revoked");
  };

  return (
    <div className="rounded-[32px] border border-white/10 bg-black/25 p-6">
      <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Active Sessions</p>
      <div className="mt-4 grid gap-3">
        {sessions.data?.map((session: AppSession) => (
          <div key={session.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium">{session.username}</p>
                <p className="text-sm text-slate-300">{session.ip_address}</p>
                <p className="mt-1 text-xs text-slate-400">{session.user_agent}</p>
              </div>
              <button onClick={() => revoke(session.id)} className="rounded-2xl border border-white/10 px-4 py-2 text-sm transition hover:bg-white/8">
                Revoke
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditPanel() {
  const audit = useQuery({ queryKey: ["admin-audit"], queryFn: nasApi.listAuditLogs, retry: false });
  return (
    <div className="rounded-[32px] border border-white/10 bg-black/25 p-6">
      <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Audit Trail</p>
      <div className="mt-4 space-y-3">
        {audit.data?.map((entry: AuditEntry) => (
          <div key={entry.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="font-medium">{entry.action}</p>
            <p className="text-sm text-slate-300">{entry.target_type} · {entry.target_id}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserHome({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  return (
    <Dashboard
      onLogout={onLogout}
      permissions={me.permissions}
      allowFolderManagement={false}
    />
  );
}

function buildQrLoginUrl(token: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("qr", token);
  return url.toString();
}

function buildQrApprovalUrl(token: string, lanIp: string) {
  const host = lanIp || window.location.hostname || "localhost";
  return `http://${host}:14201/api/auth/qr/approve/${encodeURIComponent(token)}`;
}

function extractQrToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    return url.searchParams.get("qr") || trimmed;
  } catch {
    return trimmed;
  }
}

function formatRelativeExpiry(expiresAt: number) {
  const seconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "in about 1 minute";
  return `in about ${minutes} minutes`;
}

function Feature({
  icon: Icon,
  title,
  copy,
}: {
  icon: typeof Shield;
  title: string;
  copy: string;
}) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-black/20 p-5">
      <div className="mb-3 inline-flex rounded-full border border-cyan-400/20 bg-cyan-400/10 p-3 text-cyan-300">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-300">{copy}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 outline-none transition focus:border-cyan-300/60"
      />
    </label>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ConfirmProvider>
            <DropZoneProvider>
              <AppContent />
            </DropZoneProvider>
          </ConfirmProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
