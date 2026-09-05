import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CalendarClock,
  Check,
  Copy,
  Download,
  Eye,
  File,
  FolderOpen,
  KeyRound,
  Link2,
  LockKeyhole,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  publicShareApi,
  type PublicShareAdminEntry,
  type PublicShareStatus,
} from '../../lib/publicShareApi';

type Filter = 'all' | PublicShareStatus;
type ExpiryPreset = '1h' | '24h' | '7d' | '30d' | 'never' | 'custom';

function buildPublicUrl(token: string) {
  const configured = import.meta.env.VITE_PUBLIC_WEB_URL?.replace(/\/$/, '');
  const browserOrigin = /^https?:$/.test(window.location.protocol) ? window.location.origin : '';
  const base = configured || browserOrigin;
  const suffix = `/?share=${encodeURIComponent(token)}`;
  return base ? `${base}${suffix}` : suffix;
}

function formatDate(value: number | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value * 1000));
}

function toDateTimeLocal(value: number | null) {
  if (!value) return '';
  const date = new Date(value * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function expiryFromPreset(preset: ExpiryPreset, customValue: string) {
  const now = Math.floor(Date.now() / 1000);
  if (preset === '1h') return now + 60 * 60;
  if (preset === '24h') return now + 24 * 60 * 60;
  if (preset === '7d') return now + 7 * 24 * 60 * 60;
  if (preset === '30d') return now + 30 * 24 * 60 * 60;
  if (preset === 'never') return null;
  const custom = Math.floor(new Date(customValue).getTime() / 1000);
  if (!Number.isFinite(custom) || custom <= now) throw new Error('Choose an expiration time in the future.');
  return custom;
}

function statusClasses(status: PublicShareStatus) {
  if (status === 'active') return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200';
  if (status === 'expired') return 'border-amber-400/20 bg-amber-400/10 text-amber-200';
  return 'border-red-400/20 bg-red-400/10 text-red-200';
}

export function SharedLinksPanel() {
  const client = useQueryClient();
  const shares = useQuery({
    queryKey: ['admin-share-links'],
    queryFn: publicShareApi.list,
    retry: false,
    refetchInterval: 15_000,
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [editing, setEditing] = useState<PublicShareAdminEntry | null>(null);

  const rows = shares.data || [];
  const activeCount = rows.filter((share) => share.status === 'active').length;
  const totalViews = rows.reduce((sum, share) => sum + share.views, 0);
  const totalDownloads = rows.reduce((sum, share) => sum + share.downloads, 0);
  const protectedCount = rows.filter((share) => share.has_password && share.status === 'active').length;

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((share) => {
      if (filter !== 'all' && share.status !== filter) return false;
      if (!needle) return true;
      return [share.label, share.kind, share.created_by_name || '', share.created_by]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [filter, rows, search]);

  const copy = async (share: PublicShareAdminEntry) => {
    if (share.status !== 'active') return;
    try {
      await navigator.clipboard.writeText(buildPublicUrl(share.token));
      setCopiedToken(share.token);
      window.setTimeout(() => setCopiedToken(null), 1600);
      toast.success('Share link copied');
    } catch {
      toast.error('Could not copy share link');
    }
  };

  const revoke = async (share: PublicShareAdminEntry) => {
    if (share.status !== 'active') return;
    if (!window.confirm(`Revoke the share link for “${share.label}”?`)) return;
    try {
      await publicShareApi.revoke(share.token);
      await client.invalidateQueries({ queryKey: ['admin-share-links'] });
      toast.success('Share link revoked');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke share link');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <span className="admin-kicker">Public access control</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Shared Links</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            See what is exposed outside the NAS, watch activity, change expiration or passwords, and revoke access instantly.
          </p>
        </div>
        <button onClick={() => shares.refetch()} className="premium-secondary inline-flex items-center justify-center gap-2 self-start xl:self-auto">
          <RefreshCw className={`h-4 w-4 ${shares.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric icon={Link2} label="Active links" value={activeCount} detail={`${rows.length} total recorded`} />
        <Metric icon={Eye} label="Views" value={totalViews} detail="Share page opens" />
        <Metric icon={Download} label="Downloads" value={totalDownloads} detail="Download starts" />
        <Metric icon={LockKeyhole} label="Protected" value={protectedCount} detail="Active password shares" />
      </div>

      <div className="rounded-[28px] border border-white/10 bg-black/20 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-2 overflow-x-auto pb-1 lg:pb-0">
            {(['all', 'active', 'expired', 'revoked'] as Filter[]).map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                className={`shrink-0 rounded-xl px-3 py-2 text-xs font-semibold capitalize transition ${filter === item ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}
              >
                {item}
              </button>
            ))}
          </div>
          <label className="flex min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2.5 text-slate-400 lg:w-80">
            <Search className="h-4 w-4 shrink-0" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search shares" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-600" />
          </label>
        </div>
      </div>

      {shares.isLoading ? (
        <div className="flex min-h-56 items-center justify-center rounded-[28px] border border-white/10 bg-black/20 text-slate-400">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Loading shared links...
        </div>
      ) : shares.error ? (
        <div className="rounded-[28px] border border-red-400/20 bg-red-500/10 p-6 text-red-200">
          {(shares.error as Error).message || 'Could not load shared links'}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-white/10 bg-black/10 px-6 py-16 text-center">
          <Link2 className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-4 text-lg font-semibold text-white">No shared links here</h3>
          <p className="mt-2 text-sm text-slate-500">Create a share from Storage and it will appear in this control center.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((share) => (
            <article key={share.token} className="rounded-[26px] border border-white/10 bg-white/[0.035] p-4 transition hover:border-white/15 sm:p-5">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] xl:items-center">
                <div className="flex min-w-0 gap-3">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-cyan-400/10 text-cyan-200">
                    {share.kind === 'folder' ? <FolderOpen className="h-5 w-5" /> : <File className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="max-w-full truncate font-semibold text-white">{share.label}</h3>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusClasses(share.status)}`}>{share.status}</span>
                      {share.has_password && <span title="Password protected" className="inline-flex items-center gap-1 rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold text-violet-200"><KeyRound className="h-3 w-3" /> Password</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="capitalize">{share.kind}</span>
                      <span>Created by {share.created_by_name || share.created_by}</span>
                      <span>{formatDate(share.created_at)}</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 xl:grid-cols-2">
                  <Info label="Expires" value={share.expires_at ? formatDate(share.expires_at) : 'Never'} />
                  <Info label="Last opened" value={share.last_accessed_at ? formatDate(share.last_accessed_at) : 'Not yet'} />
                  <Info label="Views" value={String(share.views)} />
                  <Info label="Downloads" value={String(share.downloads)} />
                </div>

                <div className="flex flex-wrap gap-2 xl:justify-end">
                  <ActionButton icon={copiedToken === share.token ? Check : Copy} label={copiedToken === share.token ? 'Copied' : 'Copy'} onClick={() => copy(share)} disabled={share.status !== 'active'} />
                  <ActionButton icon={Pencil} label="Edit" onClick={() => setEditing(share)} disabled={share.status === 'revoked'} />
                  <ActionButton icon={Trash2} label="Revoke" danger onClick={() => revoke(share)} disabled={share.status !== 'active'} />
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && <EditShareModal share={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await client.invalidateQueries({ queryKey: ['admin-share-links'] }); }} />}
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: React.ElementType; label: string; value: number; detail: string }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/[0.035] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400/10 text-cyan-200"><Icon className="h-4 w-4" /></div><Activity className="h-4 w-4 text-slate-700" /></div>
      <div className="mt-4 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-white sm:text-3xl">{value}</div>
      <div className="mt-1 text-xs text-slate-600">{detail}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">{label}</div><div className="mt-1 truncate font-medium text-slate-300" title={value}>{value}</div></div>;
}

function ActionButton({ icon: Icon, label, onClick, danger = false, disabled = false }: { icon: React.ElementType; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 ${danger ? 'border-red-400/20 bg-red-400/5 text-red-300 hover:bg-red-400/10' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'}`}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function EditShareModal({ share, onClose, onSaved }: { share: PublicShareAdminEntry; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [preset, setPreset] = useState<ExpiryPreset>(share.expires_at ? 'custom' : 'never');
  const [customExpiry, setCustomExpiry] = useState(toDateTimeLocal(share.expires_at));
  const [password, setPassword] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    try {
      setSaving(true);
      const expiresAt = expiryFromPreset(preset, customExpiry);
      await publicShareApi.update(share.token, {
        expires_at: expiresAt,
        password: !removePassword && password.trim() ? password.trim() : undefined,
        remove_password: removePassword,
      });
      toast.success(share.status === 'expired' ? 'Share reactivated' : 'Share settings updated');
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update share');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[30px] border border-white/10 bg-[#111c29] p-5 shadow-2xl sm:p-6" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div><span className="admin-kicker">Share settings</span><h3 className="mt-1 truncate text-xl font-semibold text-white">{share.label}</h3></div>
          <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button>
        </div>

        <div className="mt-6 space-y-5">
          <div>
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200"><CalendarClock className="h-4 w-4 text-cyan-300" /> Expiration</label>
            <select value={preset} onChange={(event) => setPreset(event.target.value as ExpiryPreset)} className="w-full rounded-xl border border-white/10 bg-[#0c1520] px-3 py-3 text-sm text-white outline-none focus:border-cyan-400/60">
              <option value="1h">1 hour from now</option><option value="24h">24 hours from now</option><option value="7d">7 days from now</option><option value="30d">30 days from now</option><option value="never">Never expires</option><option value="custom">Custom date & time</option>
            </select>
            {preset === 'custom' && <input type="datetime-local" value={customExpiry} onChange={(event) => setCustomExpiry(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-[#0c1520] px-3 py-3 text-sm text-white outline-none focus:border-cyan-400/60" />}
          </div>

          <div>
            <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200"><KeyRound className="h-4 w-4 text-cyan-300" /> Share password</label>
            <input disabled={removePassword} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={share.has_password ? 'Enter a new password to replace current' : 'Optional new password'} className="w-full rounded-xl border border-white/10 bg-[#0c1520] px-3 py-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-400/60 disabled:opacity-40" />
            {share.has_password && <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={removePassword} onChange={(event) => setRemovePassword(event.target.checked)} className="h-4 w-4 accent-cyan-400" /> Remove the current password</label>}
          </div>

          {share.status === 'expired' && <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100"><ShieldCheck className="mr-1 inline h-4 w-4" /> Saving a future expiration will reactivate this expired link unless a newer active link already exists for the same item.</div>}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/5">Cancel</button>
          <button onClick={save} disabled={saving} className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-50">{saving ? 'Saving...' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}
