import { useEffect, useMemo, useState } from 'react';
import { Check, Clock3, Copy, Link2, Share2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { publicShareApi, type PublicShareKind } from '../../lib/publicShareApi';

export const OPEN_SHARE_LINK_EVENT = 'telegram-drive:open-share-link';

type ShareTarget = {
  kind: PublicShareKind;
  folderId: number | null;
  messageId?: number | null;
  label: string;
};

type ExpiryPreset = '1h' | '24h' | '7d' | '30d' | 'never' | 'custom';

export function openShareLinkEditor(target: ShareTarget) {
  window.dispatchEvent(new CustomEvent<ShareTarget>(OPEN_SHARE_LINK_EVENT, { detail: target }));
}

function expiryFromPreset(preset: ExpiryPreset, customValue: string): number | null {
  const now = Math.floor(Date.now() / 1000);
  if (preset === '1h') return now + 60 * 60;
  if (preset === '24h') return now + 24 * 60 * 60;
  if (preset === '7d') return now + 7 * 24 * 60 * 60;
  if (preset === '30d') return now + 30 * 24 * 60 * 60;
  if (preset === 'never') return null;
  if (!customValue) throw new Error('Choose a custom expiration date and time.');
  const value = Math.floor(new Date(customValue).getTime() / 1000);
  if (!Number.isFinite(value) || value <= now) throw new Error('Expiration must be in the future.');
  return value;
}

function formatExpiry(value: number | null) {
  if (!value) return 'No expiration';
  return new Date(value * 1000).toLocaleString();
}

function buildPublicUrl(token: string) {
  const configured = import.meta.env.VITE_PUBLIC_WEB_URL?.replace(/\/$/, '');
  const browserOrigin = /^https?:$/.test(window.location.protocol) ? window.location.origin : '';
  const base = configured || browserOrigin;
  return base ? `${base}/share/${encodeURIComponent(token)}` : `/share/${encodeURIComponent(token)}`;
}

export function ShareLinkHost() {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [preset, setPreset] = useState<ExpiryPreset>('1h');
  const [customExpiry, setCustomExpiry] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<ShareTarget>).detail;
      if (!detail) return;
      setTarget(detail);
      setPreset('1h');
      setCustomExpiry('');
      setToken(null);
      setExpiresAt(null);
      setCopied(false);
    };
    window.addEventListener(OPEN_SHARE_LINK_EVENT, open);
    return () => window.removeEventListener(OPEN_SHARE_LINK_EVENT, open);
  }, []);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTarget(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target]);

  const shareUrl = useMemo(() => token ? buildPublicUrl(token) : '', [token]);

  if (!target) return null;

  const createOrUpdate = async () => {
    try {
      setLoading(true);
      const expiry = expiryFromPreset(preset, customExpiry);
      const result = await publicShareApi.create({
        kind: target.kind,
        folder_id: target.folderId,
        message_id: target.kind === 'file' ? target.messageId ?? null : null,
        label: target.label,
        expires_at: expiry,
      });
      setToken(result.token);
      setExpiresAt(result.expires_at);
      setCopied(false);
      toast.success(token ? 'Share expiration updated' : 'Share link created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create share link');
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast.success('Share link copied');
    } catch {
      toast.error('Could not copy the share link');
    }
  };

  const revoke = async () => {
    if (!token) return;
    try {
      setRevoking(true);
      await publicShareApi.revoke(token);
      setToken(null);
      setExpiresAt(null);
      toast.success('Share link revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke share link');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={() => setTarget(null)}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-[#111c29] text-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
          <div className="flex min-w-0 gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-cyan-400/10 text-cyan-300">
              <Share2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Share {target.kind}</h2>
              <p className="mt-1 truncate text-sm text-slate-400">{target.label}</p>
            </div>
          </div>
          <button onClick={() => setTarget(null)} className="grid h-9 w-9 place-items-center rounded-xl text-slate-400 transition hover:bg-white/10 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 p-5 sm:p-6">
          <div>
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
              <Clock3 className="h-4 w-4 text-cyan-300" />
              Link expiration
            </label>
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value as ExpiryPreset)}
              className="w-full rounded-xl border border-white/10 bg-[#0c1520] px-3 py-3 text-sm text-white outline-none focus:border-cyan-400/60"
            >
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="never">Never expires</option>
              <option value="custom">Custom date & time</option>
            </select>
            {preset === 'custom' && (
              <input
                type="datetime-local"
                value={customExpiry}
                onChange={(event) => setCustomExpiry(event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#0c1520] px-3 py-3 text-sm text-white outline-none focus:border-cyan-400/60"
              />
            )}
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Anyone with the link can preview and download. They cannot upload, edit, move, or delete anything.
            </p>
          </div>

          {token && (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Active share link</div>
              <div className="flex gap-2">
                <input readOnly value={shareUrl} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs text-slate-200 outline-none" />
                <button onClick={copyLink} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/15" title="Copy link">
                  {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                <Link2 className="h-3.5 w-3.5" />
                {formatExpiry(expiresAt)}
              </div>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <div>
              {token && (
                <button
                  onClick={revoke}
                  disabled={revoking}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-500/15 disabled:opacity-50 sm:w-auto"
                >
                  <Trash2 className="h-4 w-4" />
                  {revoking ? 'Revoking...' : 'Revoke link'}
                </button>
              )}
            </div>
            <button
              onClick={createOrUpdate}
              disabled={loading}
              className="flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60"
            >
              <Share2 className="h-4 w-4" />
              {loading ? 'Saving...' : token ? 'Update expiration' : 'Create share link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
