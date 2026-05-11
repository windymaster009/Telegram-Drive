import { FormEvent, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { QRCodeSVG } from "qrcode.react";
import { Chrome, Copy, Shield, UserPlus, Users, History, KeyRound, ScanQrCode, HardDrive, LogOut, ChevronDown, Skull } from "lucide-react";
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
} from "@shared/nas";
import type { TelegramFolder } from "@shared/telegram";
import khFlag from "flag-icons/flags/4x3/kh.svg?url";
import usFlag from "flag-icons/flags/4x3/us.svg?url";
import vnFlag from "flag-icons/flags/4x3/vn.svg?url";
import laFlag from "flag-icons/flags/4x3/la.svg?url";
import sgFlag from "flag-icons/flags/4x3/sg.svg?url";
import myFlag from "flag-icons/flags/4x3/my.svg?url";
import phFlag from "flag-icons/flags/4x3/ph.svg?url";
import idFlag from "flag-icons/flags/4x3/id.svg?url";
import cnFlag from "flag-icons/flags/4x3/cn.svg?url";
import jpFlag from "flag-icons/flags/4x3/jp.svg?url";
import krFlag from "flag-icons/flags/4x3/kr.svg?url";
import inFlag from "flag-icons/flags/4x3/in.svg?url";
import auFlag from "flag-icons/flags/4x3/au.svg?url";
import gbFlag from "flag-icons/flags/4x3/gb.svg?url";
import frFlag from "flag-icons/flags/4x3/fr.svg?url";
import deFlag from "flag-icons/flags/4x3/de.svg?url";
import caFlag from "flag-icons/flags/4x3/ca.svg?url";
import "./App.css";

const queryClient = new QueryClient();

type CountryOption = {
  iso: string;
  name: string;
  dialCode: string;
  flagSrc: string;
};

const PHONE_COUNTRIES: CountryOption[] = [
  { iso: "KH", name: "Cambodia", dialCode: "+855", flagSrc: khFlag },
  { iso: "US", name: "United States", dialCode: "+1", flagSrc: usFlag },
  { iso: "VN", name: "Vietnam", dialCode: "+84", flagSrc: vnFlag },
  { iso: "LA", name: "Laos", dialCode: "+856", flagSrc: laFlag },
  { iso: "SG", name: "Singapore", dialCode: "+65", flagSrc: sgFlag },
  { iso: "MY", name: "Malaysia", dialCode: "+60", flagSrc: myFlag },
  { iso: "PH", name: "Philippines", dialCode: "+63", flagSrc: phFlag },
  { iso: "ID", name: "Indonesia", dialCode: "+62", flagSrc: idFlag },
  { iso: "CN", name: "China", dialCode: "+86", flagSrc: cnFlag },
  { iso: "JP", name: "Japan", dialCode: "+81", flagSrc: jpFlag },
  { iso: "KR", name: "South Korea", dialCode: "+82", flagSrc: krFlag },
  { iso: "IN", name: "India", dialCode: "+91", flagSrc: inFlag },
  { iso: "AU", name: "Australia", dialCode: "+61", flagSrc: auFlag },
  { iso: "GB", name: "United Kingdom", dialCode: "+44", flagSrc: gbFlag },
  { iso: "FR", name: "France", dialCode: "+33", flagSrc: frFlag },
  { iso: "DE", name: "Germany", dialCode: "+49", flagSrc: deFlag },
  { iso: "CA", name: "Canada", dialCode: "+1", flagSrc: caFlag },
];

function AppContent() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const { theme } = useTheme();
  const { available, version, downloading, progress, downloadAndInstall, dismissUpdate } = useUpdateCheck();
  const client = useQueryClient();
  const runningInDesktop = useMemo(() => isDesktopRuntime(), []);
  const qrToken = useMemo(() => new URLSearchParams(window.location.search).get("qr"), []);
  const googleCode = useMemo(() => new URLSearchParams(window.location.search).get("code"), []);
  const googleError = useMemo(() => new URLSearchParams(window.location.search).get("error"), []);
  const googleState = useMemo(() => new URLSearchParams(window.location.search).get("state"), []);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [browserGoogleStatus, setBrowserGoogleStatus] = useState<"idle" | "loading" | "success" | "error">(
    googleError ? "error" : googleCode ? "loading" : "idle"
  );
  const [browserGoogleMessage, setBrowserGoogleMessage] = useState(
    googleError ? `Google login failed: ${googleError}` : "Finishing Google sign-in..."
  );
  const isBrowserGoogleCallback =
    !runningInDesktop && (Boolean(googleCode) || Boolean(googleError) || window.location.pathname.includes("/auth/google/callback"));

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
    nasSession.setCsrfToken(response.csrf_token);
    setCsrfToken(response.csrf_token);
    client.invalidateQueries({ queryKey: ["auth-me"] });
    client.invalidateQueries({ queryKey: ["system-status"] });
  };

  const handleLogout = async () => {
    try {
      await nasApi.logout(csrfToken || undefined);
    } finally {
      nasSession.clearAccessToken();
      nasSession.clearCsrfToken();
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
    if (googleError) {
      if (isBrowserGoogleCallback) {
        setBrowserGoogleStatus("error");
        setBrowserGoogleMessage(`Google login failed: ${googleError}. Return to Telegram Drive and try again.`);
        return;
      }
      toast.error(`Google login failed: ${googleError}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [googleError, isBrowserGoogleCallback]);

  useEffect(() => {
    if (!googleCode || systemQuery.data?.setup_required) return;

    const expectedState = window.sessionStorage.getItem("telegram_drive_google_oauth_state");
    if (!expectedState && googleState) {
      if (isBrowserGoogleCallback) {
        setBrowserGoogleStatus("loading");
        setBrowserGoogleMessage("Finishing Google sign-in...");
      }
      setGoogleLoading(true);
      nasApi
        .googleDesktopComplete({
          code: googleCode,
          state: googleState,
          redirect_uri: googleRedirectUri(),
        })
        .then(() => {
          if (isBrowserGoogleCallback) {
            setBrowserGoogleStatus("success");
            setBrowserGoogleMessage("Login complete. Go back to the Telegram Drive desktop app.");
          } else {
            window.history.replaceState({}, "", window.location.pathname);
          }
        })
        .catch((error) => {
          if (isBrowserGoogleCallback) {
            setBrowserGoogleStatus("error");
            setBrowserGoogleMessage(`${error.message || "Google login failed"}. Return to Telegram Drive and try again.`);
          } else {
            toast.error(error.message || "Google login failed");
            window.history.replaceState({}, "", window.location.pathname);
          }
        })
        .finally(() => setGoogleLoading(false));
      return;
    }

    if (expectedState && googleState !== expectedState) {
      toast.error("Google login state did not match. Try signing in again.");
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    setGoogleLoading(true);
    nasApi
      .googleLogin({
        code: googleCode,
        redirect_uri: googleRedirectUri(),
      })
      .then((response) => {
        window.sessionStorage.removeItem("telegram_drive_google_oauth_state");
        finishLogin(response);
        window.history.replaceState({}, "", window.location.pathname);
        toast.success("Signed in with Google");
      })
      .catch((error) => {
        toast.error(error.message || "Google login failed");
        window.history.replaceState({}, "", window.location.pathname);
      })
      .finally(() => setGoogleLoading(false));
  }, [googleCode, googleState, isBrowserGoogleCallback, systemQuery.data?.setup_required]);

  useEffect(() => {
    if (meQuery.data?.csrf_token) {
      nasSession.setCsrfToken(meQuery.data.csrf_token);
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

      {isBrowserGoogleCallback ? (
        <BrowserGoogleCallbackPage status={browserGoogleStatus} message={browserGoogleMessage} />
      ) : !runningInDesktop ? (
        <WebDisabledPage />
      ) : googleLoading ? (
        <CenteredCard title="Completing Google Login" subtitle="Exchanging your Google sign-in code with the backend..." />
      ) : isLoading ? (
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
      ) : meQuery.data.user.disabled || !meQuery.data.user.is_approved || meQuery.data.user.approval_status !== "approved" ? (
        <ApprovalReviewPage me={meQuery.data} onLogout={handleLogout} />
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

function BrowserGoogleCallbackPage({
  status,
  message,
}: {
  status: "idle" | "loading" | "success" | "error";
  message: string;
}) {
  const title =
    status === "success"
      ? "Go Back to Telegram Drive"
      : status === "error"
        ? "Google Sign-In Failed"
        : "Finishing Google Sign-In";
  const subtitle = message;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-black/25 p-8 text-center shadow-2xl backdrop-blur-xl">
        <div className="mx-auto mb-5 inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300">
          <Chrome className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">{subtitle}</p>
        {status === "loading" && <p className="mt-4 text-xs uppercase tracking-[0.24em] text-cyan-200">Please wait</p>}
      </div>
    </div>
  );
}

function WebDisabledPage() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-black/25 p-8 text-center shadow-2xl backdrop-blur-xl">
        <div className="mx-auto mb-5 inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300">
          <Shield className="h-6 w-6" />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Open Telegram Drive Desktop</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">
          The browser is only used for trusted Google sign-in. Return to the Telegram Drive desktop app to continue.
        </p>
      </div>
    </div>
  );
}

function ApprovalReviewPage({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const rejected = me.user.approval_status === "rejected";
  const disabled = me.user.disabled;
  const title = disabled
    ? "Account Disabled"
    : rejected
      ? "Access Request Rejected"
      : "Account Under Review";
  const subtitle = disabled
    ? "This account cannot access Telegram Drive right now. Contact an administrator for help."
    : rejected
      ? "An administrator rejected this access request. Contact an administrator if this was a mistake."
      : "Your account is waiting for administrator approval. You will be able to use Telegram Drive after approval.";

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-[28px] border border-white/10 bg-black/25 p-8 text-center shadow-2xl backdrop-blur-xl">
        <div className="mx-auto mb-5 inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300">
          <Shield className="h-6 w-6" />
        </div>
        <p className="text-xs uppercase tracking-[0.28em] text-cyan-200">{me.user.display_name}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">{subtitle}</p>
        <button
          type="button"
          onClick={onLogout}
          className="mt-7 rounded-2xl border border-white/10 px-5 py-3 text-sm font-medium text-slate-100 transition hover:bg-white/8"
        >
          <span className="inline-flex items-center justify-center gap-2"><LogOut className="h-4 w-4" /> Sign Out</span>
        </button>
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

  const handleGoogleLogin = async () => {
    const clientId = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) {
      toast.error("Set VITE_GOOGLE_OAUTH_CLIENT_ID in frontend/.env first");
      return;
    }

    const state = crypto.randomUUID();
    window.sessionStorage.setItem("telegram_drive_google_oauth_state", state);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", googleRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);

    setLoading(true);
    try {
      await open(url.toString());
    } catch {
      const browserWindow = window.open(url.toString(), "_blank", "noopener,noreferrer");
      if (!browserWindow) {
        window.location.href = url.toString();
        return;
      }
    }

    try {
      const response = await waitForGoogleDesktopLogin(state);
      window.sessionStorage.removeItem("telegram_drive_google_oauth_state");
      onLoggedIn(response);
      toast.success("Signed in with Google");
    } catch (error) {
      toast.error((error as Error).message || "Google login failed");
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
          <h1 className="text-4xl font-semibold tracking-tight">Google sign-in for Telegram Drive</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">
            Users sign in with Google and wait for admin approval before accessing Telegram storage. Telegram API ID, API Hash, and MTProto login stay in the backend.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Feature icon={Users} title="Approval required" copy="New Google users are created as pending until an admin approves them." />
            <Feature icon={Shield} title="Backend-only secrets" copy="Google, MongoDB, JWT, Telegram, and session encryption secrets never go to the frontend." />
          </div>
        </div>
        <form onSubmit={handleSubmit} className="rounded-[36px] border border-white/10 bg-black/25 p-8 backdrop-blur-2xl">
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={loading}
            className="mb-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 font-medium text-slate-950 transition hover:bg-slate-100 disabled:opacity-60"
          >
            <Chrome className="h-5 w-5" />
            Continue with Google
          </button>
          <div className="mb-5 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-slate-500">
            <span className="h-px flex-1 bg-white/10" />
            Legacy login
            <span className="h-px flex-1 bg-white/10" />
          </div>
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
  const ownerSessionQuery = useQuery({
    queryKey: ["owner-status"],
    queryFn: nasApi.ownerStatus,
    retry: false,
  });
  const ownerConnected = ownerSessionQuery.data?.connected ?? systemStatus.owner_connected;
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
        currentUser={me.user}
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
              Signed in as {me.user.display_name}. Owner Telegram session is {ownerConnected ? "connected" : "waiting"}.
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
        {tab === "owner" && <OwnerTelegramPanel csrfToken={csrfToken} onOpenStorage={() => setTab("storage")} />}
        {tab === "users" && <UsersPanel csrfToken={csrfToken} me={me.user} />}
        {tab === "sessions" && <SessionsPanel csrfToken={csrfToken} />}
        {tab === "audit" && <AuditPanel />}
      </section>
    </div>
  );
}

function OwnerTelegramPanel({ csrfToken, onOpenStorage }: { csrfToken: string | null; onOpenStorage: () => void }) {
  const client = useQueryClient();
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phoneCountry, setPhoneCountry] = useState<CountryOption | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"config" | "code" | "password">("config");
  const [checkingSavedSession, setCheckingSavedSession] = useState(false);
  const [checkedSavedSession, setCheckedSavedSession] = useState(false);
  const [ownerConnectionError, setOwnerConnectionError] = useState("");
  const [ownerActionLoading, setOwnerActionLoading] = useState(false);
  const ownerStatus = useQuery({
    queryKey: ["owner-status"],
    queryFn: nasApi.ownerStatus,
    retry: false,
  });
  const ownerConfigured = Boolean(ownerStatus.data?.configured);
  const hasCredentialDraft = Boolean(apiId.trim() || apiHash.trim());
  const visibleOwnerError = ownerStatus.data?.connected ? "" : ownerConnectionError || ownerStatus.data?.error || "";
  const canClearOwnerSetup = ownerConfigured || visibleOwnerError.includes("encrypted Telegram data");

  useEffect(() => {
    if (!ownerConfigured || ownerStatus.data?.connected || checkingSavedSession || checkedSavedSession) return;

    setCheckingSavedSession(true);
    nasApi.ownerStatus()
      .then(async (connected) => {
        if (connected.connected) {
          await ownerStatus.refetch();
          client.invalidateQueries({ queryKey: ["system-status"] });
          client.invalidateQueries({ queryKey: ["auth-me"] });
          setOwnerConnectionError("");
        } else if (connected.error) {
          setOwnerConnectionError(connected.error);
        }
      })
      .catch((error) => {
        setOwnerConnectionError((error as Error).message || "Telegram connection check failed");
      })
      .finally(() => {
        setCheckedSavedSession(true);
        setCheckingSavedSession(false);
      });
  }, [checkedSavedSession, checkingSavedSession, client, ownerConfigured, ownerStatus.data?.connected, ownerStatus.refetch]);

  const ownerErrorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (message.includes("aead::Error")) {
      return "Saved encrypted Telegram data could not be decrypted. Clear Saved Setup, then save the API credentials and request a new code.";
    }
    if (message) return message;
    return "Telegram owner action failed";
  };

  const saveOwnerConfig = async () => {
    if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
    if (!apiId.trim() || !apiHash.trim()) {
      throw new Error("Enter Telegram API ID and API Hash first.");
    }
    await nasApi.saveOwnerConfig({ api_id: Number(apiId), api_hash: apiHash }, csrfToken);
  };

  const requestCode = async () => {
    if (ownerActionLoading) return;
    setOwnerActionLoading(true);
    setOwnerConnectionError("");
    try {
      const normalizedPhone = phone.trim().replace(/\s+/g, "");
      if (!normalizedPhone || (phoneCountry && normalizedPhone === phoneCountry.dialCode)) {
        toast.error("Enter the Telegram phone number first");
        return;
      }

      if (ownerConfigured && !hasCredentialDraft) {
        if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
        await nasApi.requestOwnerCode({ phone: normalizedPhone }, csrfToken);
      } else {
        await saveOwnerConfig();
        if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
        await nasApi.requestOwnerCode({ phone: normalizedPhone }, csrfToken);
      }
      setStep("code");
      setOwnerConnectionError("");
      toast.success("Telegram code requested");
    } catch (error) {
      const message = ownerErrorMessage(error);
      setOwnerConnectionError(message);
      toast.error(message);
    } finally {
      setOwnerActionLoading(false);
    }
  };

  const completeCode = async () => {
    if (ownerActionLoading) return;
    setOwnerActionLoading(true);
    try {
      if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
      const response = await nasApi.ownerSignIn({ code }, csrfToken);
      if (response.success) {
        toast.success("Owner Telegram session connected");
        await ownerStatus.refetch();
        client.invalidateQueries({ queryKey: ["system-status"] });
        client.invalidateQueries({ queryKey: ["auth-me"] });
        setOwnerConnectionError("");
      } else if (response.next_step === "password") {
        setStep("password");
      }
    } catch (error) {
      const message = ownerErrorMessage(error);
      setOwnerConnectionError(message);
      toast.error(message);
    } finally {
      setOwnerActionLoading(false);
    }
  };

  const completePassword = async () => {
    if (ownerActionLoading) return;
    setOwnerActionLoading(true);
    try {
      if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
      const response = await nasApi.ownerCheckPassword({ password }, csrfToken);
      if (response.success) {
        toast.success("Owner Telegram session connected");
        await ownerStatus.refetch();
        client.invalidateQueries({ queryKey: ["system-status"] });
        client.invalidateQueries({ queryKey: ["auth-me"] });
        setOwnerConnectionError("");
      }
    } catch (error) {
      const message = ownerErrorMessage(error);
      setOwnerConnectionError(message);
      toast.error(message);
    } finally {
      setOwnerActionLoading(false);
    }
  };

  const killTelegramSession = async () => {
    try {
      if (!csrfToken) throw new Error("Admin session is missing. Sign out and sign in again.");
      await nasApi.ownerLogout(csrfToken);
      setStep("config");
      setCode("");
      setPassword("");
      setCheckedSavedSession(true);
      setOwnerConnectionError("");
      await ownerStatus.refetch();
      client.invalidateQueries({ queryKey: ["system-status"] });
      client.invalidateQueries({ queryKey: ["auth-me"] });
      toast.success("Telegram session killed");
    } catch (error) {
      toast.error(ownerErrorMessage(error));
    }
  };

  const clearOwnerSetup = async () => {
    if (!csrfToken || ownerActionLoading) return;
    setOwnerActionLoading(true);
    try {
      await nasApi.clearOwnerConfig(csrfToken);
      setApiId("");
      setApiHash("");
      setCode("");
      setPassword("");
      setStep("config");
      setCheckedSavedSession(false);
      setOwnerConnectionError("");
      await ownerStatus.refetch();
      client.invalidateQueries({ queryKey: ["system-status"] });
      client.invalidateQueries({ queryKey: ["auth-me"] });
      toast.success("Saved owner setup cleared");
    } catch (error) {
      toast.error(ownerErrorMessage(error));
    } finally {
      setOwnerActionLoading(false);
    }
  };

  if (ownerStatus.data?.connected) {
    return (
      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[32px] border border-white/10 bg-white/6 p-6">
          <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Owner Session</p>
          <h2 className="mt-2 text-2xl font-semibold">One Telegram account for the whole NAS</h2>
          <p className="mt-4 text-sm leading-7 text-slate-300">
            The owner Telegram session is active. Normal users can now use their assigned storage access without seeing Telegram credentials.
          </p>
          <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm">
            <p>Configured: <strong>Yes</strong></p>
            <p>Connected: <strong className="text-emerald-200">Yes</strong></p>
          </div>
        </div>
        <div className="rounded-[32px] border border-emerald-400/20 bg-emerald-400/8 p-8">
          <div className="inline-flex rounded-full border border-emerald-300/30 bg-emerald-300/10 p-3 text-emerald-200">
            <Shield className="h-6 w-6" />
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight">Login Success</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300">
            Telegram Drive is connected to the owner Telegram account and ready to manage storage.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={onOpenStorage}
              className="rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300"
            >
              <span className="inline-flex items-center justify-center gap-2"><HardDrive className="h-4 w-4" /> Go to Storage</span>
            </button>
            <button
              type="button"
              onClick={killTelegramSession}
              className="rounded-2xl border border-red-300/25 bg-red-400/10 px-4 py-3 font-medium text-red-100 transition hover:bg-red-400/15"
            >
              <span className="inline-flex items-center justify-center gap-2"><LogOut className="h-4 w-4" /> Kill Telegram Session</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="rounded-[32px] border border-white/10 bg-white/6 p-6">
        <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Owner Session</p>
        <h2 className="mt-2 text-2xl font-semibold">One Telegram account for the whole NAS</h2>
        <p className="mt-4 text-sm leading-7 text-slate-300">
          Configure the owner account once. Normal users never see API credentials or MTProto login prompts.
        </p>
        <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm">
          <p>Configured: <strong>{ownerConfigured ? "Yes" : "No"}</strong></p>
          <p>Connected: <strong>{ownerStatus.data?.connected ? "Yes" : "No"}</strong></p>
        </div>
        {checkingSavedSession && (
          <p className="mt-3 text-sm text-cyan-200">Checking saved Telegram session...</p>
        )}
        {visibleOwnerError && (
          <div className="mt-4 rounded-2xl border border-red-300/25 bg-red-400/10 p-4 text-sm leading-6 text-red-100">
            <p className="font-medium">Telegram connection error</p>
            <p className="mt-1 break-words text-red-100/90">{visibleOwnerError}</p>
          </div>
        )}
        {canClearOwnerSetup && (
          <button
            type="button"
            onClick={clearOwnerSetup}
            disabled={ownerActionLoading}
            className="mt-4 rounded-2xl border border-red-300/25 px-4 py-2 text-sm text-red-100 transition hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="inline-flex items-center gap-2"><LogOut className="h-4 w-4" /> Clear Saved Setup</span>
          </button>
        )}
      </div>
      <div className="rounded-[32px] border border-white/10 bg-black/25 p-6">
        <div className="grid items-start gap-4 md:grid-cols-2">
          <Field
            label={ownerConfigured ? `Telegram API ID${ownerStatus.data?.api_id ? ` (${ownerStatus.data.api_id} saved)` : ""}` : "Telegram API ID"}
            value={apiId}
            onChange={setApiId}
          />
          <Field
            label={ownerConfigured ? "Telegram API Hash (saved, enter to replace)" : "Telegram API Hash"}
            value={apiHash}
            onChange={setApiHash}
          />
          <PhoneNumberField
            country={phoneCountry}
            countries={PHONE_COUNTRIES}
            value={phone}
            onCountryChange={(country) => {
              setPhoneCountry(country);
              setPhone((current) => applyDialCode(current, phoneCountry?.dialCode || "", country.dialCode));
            }}
            onChange={(value) => {
              setPhone(value);
              setPhoneCountry(detectCountryFromPhone(value));
            }}
          />
          <div className="flex items-start pt-7">
            <button
              type="button"
              onClick={requestCode}
              disabled={ownerActionLoading}
              className="w-full rounded-2xl bg-cyan-400 px-4 py-3 font-medium text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {ownerActionLoading ? "Requesting..." : ownerConfigured && !hasCredentialDraft ? "Request Code" : "Save & Request Code"}
            </button>
          </div>
        </div>
        {step === "code" && (
          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
            <Field label="Telegram code" value={code} onChange={setCode} />
            <div className="flex items-end">
              <button
                type="button"
                onClick={completeCode}
                disabled={ownerActionLoading}
                className="rounded-2xl border border-white/10 px-4 py-3 text-sm transition hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ownerActionLoading ? "Verifying..." : "Verify Code"}
              </button>
            </div>
          </div>
        )}
        {step === "password" && (
          <div className="mt-6 grid gap-4 md:grid-cols-[1fr_auto]">
            <Field label="2FA password" type="password" value={password} onChange={setPassword} />
            <div className="flex items-end">
              <button
                type="button"
                onClick={completePassword}
                disabled={ownerActionLoading}
                className="rounded-2xl border border-white/10 px-4 py-3 text-sm transition hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ownerActionLoading ? "Verifying..." : "Verify Password"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UsersPanel({ csrfToken, me }: { csrfToken: string | null; me: AppUser }) {
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
        return await invoke<TelegramFolder[]>("cmd_scan_folders", {
          accessToken: nasSession.getAccessToken(),
          actor: {
            userId: me.id,
            displayName: me.display_name,
            email: me.email || me.username,
            role: me.role,
          },
        });
      } catch {
        return [];
      }
    },
    enabled: !!selectedUser,
  });
  const [permissionDraft, setPermissionDraft] = useState<PermissionAssignment[]>([]);
  const selectedUserIsApproved = selectedUser?.approval_status === "approved" && selectedUser.is_approved;
  const selectedUserIsRejected = selectedUser?.approval_status === "rejected";

  useEffect(() => {
    setPermissionDraft(permissions.data || []);
  }, [permissions.data]);

  const availableFolders = useMemo(
    () => [
      ...(folderCatalog.data || []).map((folder) => ({
        id: String(folder.id),
        name: folder.name,
        owner_id: folder.owner_id || null,
      })),
    ],
    [folderCatalog.data]
  );

  const setFolderPermission = (
    folder: { id: string; name: string; owner_id?: string | null },
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
          owner_id: null,
          owner_name: null,
          icon: null,
          is_password_protected: false,
          can_manage: false,
        },
      ];
    });
  };

  const refresh = () => {
    client.invalidateQueries({ queryKey: ["admin-users"] });
    if (selectedUser) client.invalidateQueries({ queryKey: ["user-permissions", selectedUser.id] });
  };

  const setSelectedUserApproval = async (approvalStatus: AppUser["approval_status"]) => {
    if (!csrfToken || !selectedUser) return;
    try {
      await nasApi.setUserApproval(selectedUser.id, approvalStatus, csrfToken);
      const isApproved = approvalStatus === "approved";
      setSelectedUser({ ...selectedUser, approval_status: approvalStatus, is_approved: isApproved });
      refresh();
      toast.success(approvalStatus === "approved" ? "User approved" : approvalStatus === "rejected" ? "User rejected" : "User moved to pending");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  const setSelectedUserDisabled = async (disabled: boolean) => {
    if (!csrfToken || !selectedUser) return;
    try {
      await nasApi.updateUser(selectedUser.id, { disabled }, csrfToken);
      setSelectedUser({ ...selectedUser, disabled });
      refresh();
      toast.success(disabled ? "User disabled" : "User enabled");
    } catch (error) {
      toast.error((error as Error).message);
    }
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
      const normalizedPermissions = permissionDraft.map((permission) => ({
        ...permission,
        owner_id: permission.owner_id ?? null,
        owner_name: permission.owner_name ?? null,
        icon: permission.icon ?? null,
        is_password_protected: Boolean(permission.is_password_protected),
        can_manage: Boolean(permission.can_manage),
      }));
      const normalizedByFolder = new Map(normalizedPermissions.map((permission) => [permission.folder_id, permission]));
      for (const folder of availableFolders) {
        if (folder.owner_id !== selectedUser.id) continue;
        const existingPermission = normalizedByFolder.get(folder.id);
        normalizedByFolder.set(folder.id, {
          ...existingPermission,
          folder_id: folder.id,
          folder_label: existingPermission?.folder_label || folder.name,
          access_level: "read_write",
          is_private: existingPermission?.is_private ?? false,
          owner_id: existingPermission?.owner_id ?? selectedUser.id,
          owner_name: existingPermission?.owner_name ?? selectedUser.display_name,
          icon: existingPermission?.icon ?? null,
          is_password_protected: Boolean(existingPermission?.is_password_protected),
          can_manage: true,
        });
      }
      const nextPermissions = Array.from(normalizedByFolder.values());
      await nasApi.setPermissions(selectedUser.id, nextPermissions, csrfToken);
      setPermissionDraft(nextPermissions);
      client.setQueryData(["user-permissions", selectedUser.id], nextPermissions);
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.32em] text-cyan-300">Users</p>
            <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-3 py-1 text-xs text-amber-100">
              {(users.data || []).filter((user) => user.approval_status === "pending" || !user.is_approved).length} pending
            </span>
          </div>
          <div className="mt-4 grid gap-3">
            {users.data?.map((user) => (
              <button key={user.id} onClick={() => { setSelectedUser(user); setPermissionDraft([]); setQr(null); }} className="rounded-2xl border border-white/10 bg-black/25 p-4 text-left transition hover:bg-white/8">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{user.display_name}</p>
                    {user.telegram_username && <p className="mt-1 text-xs text-cyan-200">{user.telegram_username}</p>}
                    <p className="text-sm text-slate-300">@{user.username} · {user.role}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs ${
                    user.disabled
                      ? "bg-red-500/20 text-red-200"
                      : user.approval_status === "approved" && user.is_approved
                        ? "bg-emerald-500/20 text-emerald-200"
                        : user.approval_status === "rejected"
                          ? "bg-red-500/20 text-red-200"
                          : "bg-amber-500/20 text-amber-100"
                  }`}>
                    {user.disabled
                      ? "Disabled"
                      : user.approval_status === "approved" && user.is_approved
                        ? "Approved"
                        : user.approval_status === "rejected"
                          ? "Rejected"
                          : "Pending approval"}
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
                <p className="mt-2 text-xs text-slate-400">
                  Approval: <span className="text-white">{selectedUser.approval_status}</span>
                  {selectedUser.disabled && <span className="text-red-200"> · disabled</span>}
                  {selectedUser.is_approved ? " · can access storage" : " · waiting for approval"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!selectedUserIsApproved && (
                  <button
                    type="button"
                    onClick={() => setSelectedUserApproval("approved")}
                    className="rounded-2xl border border-emerald-300/25 px-4 py-2 text-sm text-emerald-100 transition hover:bg-emerald-400/10"
                  >
                    Approve
                  </button>
                )}
                {!selectedUserIsApproved && !selectedUserIsRejected && (
                  <button
                    type="button"
                    onClick={() => setSelectedUserApproval("rejected")}
                    className="rounded-2xl border border-red-300/25 px-4 py-2 text-sm text-red-100 transition hover:bg-red-400/10"
                  >
                    Reject
                  </button>
                )}
                {selectedUserIsRejected && (
                  <button
                    type="button"
                    onClick={() => setSelectedUserApproval("pending")}
                    className="rounded-2xl border border-amber-300/25 px-4 py-2 text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Move Pending
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedUserDisabled(!selectedUser.disabled)}
                  className={`rounded-2xl border px-4 py-2 text-sm transition ${
                    selectedUser.disabled
                      ? "border-emerald-300/25 text-emerald-100 hover:bg-emerald-400/10"
                      : "border-red-300/25 text-red-100 hover:bg-red-400/10"
                  }`}
                >
                  {selectedUser.disabled ? "Enable" : "Disable"}
                </button>
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
                  const isOwnedBySelectedUser = folder.owner_id === selectedUser.id;
                  const selectedAccess = isOwnedBySelectedUser ? "read_write" : permission?.access_level || "hidden";

                  return (
                    <div key={folder.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/8 bg-black/20 p-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3 text-sm">
                        <span className="min-w-0">
                          <span className={`block truncate font-medium ${selectedAccess === "hidden" ? "text-white/55" : "text-white"}`}>{folder.name}</span>
                          <span className="block truncate text-xs text-slate-400">{folder.id === "root" ? "Owner Saved Messages" : `Telegram folder ${folder.id}`}</span>
                          <span className={`mt-1 block text-xs ${
                            isOwnedBySelectedUser
                              ? "text-emerald-200"
                              : selectedAccess === "hidden"
                              ? "text-slate-500"
                              : selectedAccess === "read_write"
                                ? "text-emerald-200"
                                : "text-cyan-200"
                          }`}>
                            {isOwnedBySelectedUser ? "Owner folder · always read + write" : selectedAccess === "hidden" ? "Hidden from this user" : selectedAccess === "read_write" ? "Can view and upload" : "Can view only"}
                          </span>
                        </span>
                      </div>
                      <select
                        disabled={isOwnedBySelectedUser}
                        value={selectedAccess}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "hidden") {
                            setFolderPermission(folder, false);
                            return;
                          }
                          setFolderPermission(folder, true, value as PermissionAssignment["access_level"]);
                        }}
                        className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <option value="hidden">Hidden</option>
                        <option value="read_write">Read + Write</option>
                        <option value="read_only">Read Only</option>
                      </select>
                    </div>
                  );
                })}
                {availableFolders.length === 0 && (
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
      currentUser={me.user}
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

function googleRedirectUri() {
  return import.meta.env.VITE_GOOGLE_OAUTH_REDIRECT_URI || `${window.location.origin}/auth/google/callback`;
}

function isDesktopRuntime() {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function waitForGoogleDesktopLogin(state: string) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(2000);
    const status = await nasApi.googleDesktopStatus(state);
    if (status.status === "complete") return status.response;
    if (status.status === "error") throw new Error(status.error);
  }
  throw new Error("Google login timed out. Try signing in again.");
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function PhoneNumberField({
  country,
  countries,
  value,
  onCountryChange,
  onChange,
}: {
  country: CountryOption | null;
  countries: CountryOption[];
  value: string;
  onCountryChange: (country: CountryOption) => void;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const showUnknownCountry = value.trim().startsWith("+") && !country;

  return (
    <div className="relative block text-sm">
      <span className="mb-2 block text-slate-300">Phone number</span>
      <div className="flex min-h-12 overflow-hidden rounded-2xl border border-white/10 bg-white/5 transition focus-within:border-cyan-300/60">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-[116px] shrink-0 items-center gap-2 border-r border-white/10 bg-slate-950/70 px-3 text-left text-sm text-white outline-none transition hover:bg-slate-900"
          aria-expanded={open}
        >
          {country ? (
            <>
              <img src={country.flagSrc} alt="" className="h-4 w-6 rounded-[2px] object-cover" />
              <span className="font-medium">{country.iso}</span>
            </>
          ) : showUnknownCountry ? (
            <>
              <span className="grid h-4 w-6 place-items-center rounded-[2px] bg-slate-800 text-slate-100">
                <Skull className="h-3 w-3" />
              </span>
              <span className="font-medium">??</span>
            </>
          ) : (
            <span className="text-slate-300">Country</span>
          )}
          <ChevronDown className="ml-auto h-4 w-4 text-slate-400" />
        </button>
        <input
          type="tel"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Phone number"
          className="min-w-0 flex-1 bg-transparent px-4 py-3 outline-none"
        />
      </div>
      {open && (
        <div className="absolute left-0 top-[76px] z-30 max-h-64 w-80 overflow-auto rounded-2xl border border-white/10 bg-slate-950 p-2 shadow-2xl">
          {countries.map((item) => (
            <button
              key={item.iso}
              type="button"
              onClick={() => {
                onCountryChange(item);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/8 ${
                item.iso === country?.iso ? "bg-cyan-400/12 text-cyan-100" : "text-slate-200"
              }`}
            >
              <img src={item.flagSrc} alt="" className="h-4 w-5 rounded-[2px] object-cover" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-slate-400">{item.dialCode}</span>
            </button>
          ))}
        </div>
      )}
      <span className="mt-2 block text-xs text-slate-500">
        {country?.name || (showUnknownCountry ? "Unknown country code" : "Choose a country to fill the dial code")}
      </span>
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

function applyDialCode(current: string, previousDialCode: string, nextDialCode: string) {
  const trimmed = current.trim();
  if (!trimmed || (previousDialCode && trimmed === previousDialCode)) return `${nextDialCode} `;

  if (previousDialCode && trimmed.startsWith(previousDialCode)) {
    return `${nextDialCode}${trimmed.slice(previousDialCode.length)}`;
  }

  if (trimmed.startsWith("+")) {
    return `${nextDialCode} ${trimmed.replace(/^\+\d+\s*/, "")}`;
  }

  return `${nextDialCode} ${trimmed.replace(/^0+/, "")}`;
}

function detectCountryFromPhone(value: string) {
  const normalized = value.replace(/[\s()-]/g, "");
  if (!normalized.startsWith("+")) return null;

  return (
    [...PHONE_COUNTRIES]
      .sort((first, second) => second.dialCode.length - first.dialCode.length)
      .find((country) => normalized.startsWith(country.dialCode)) || null
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

