import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Clock3,
  Download,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  LockKeyhole,
  Play,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { TelegramFile } from '@shared/telegram';
import { formatBytes } from '../../utils';
import {
  PublicSharePasswordRequiredError,
  publicShareApi,
  type PublicShareView,
} from '../../lib/publicShareApi';
import { WordDocumentViewer } from '../dashboard/WordDocumentViewer';
import { ExcelWorkbookViewer } from '../dashboard/ExcelWorkbookViewer';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'csv', 'ini', 'conf',
  'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'html', 'css', 'sql', 'sh', 'ps1', 'rtf',
]);
const EXCEL_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'aac', 'flac']);

function extension(file: TelegramFile) {
  if (file.file_ext) return file.file_ext.toLowerCase().replace(/^\./, '');
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function isImage(file: TelegramFile) {
  return Boolean(file.mime_type?.startsWith('image/')) || IMAGE_EXTENSIONS.has(extension(file));
}

function isVideo(file: TelegramFile) {
  return Boolean(file.mime_type?.startsWith('video/')) || VIDEO_EXTENSIONS.has(extension(file));
}

function isAudio(file: TelegramFile) {
  return Boolean(file.mime_type?.startsWith('audio/')) || AUDIO_EXTENSIONS.has(extension(file));
}

function formatExpiry(value: number | null) {
  if (!value) return 'This link does not expire';
  return `Expires ${new Date(value * 1000).toLocaleString()}`;
}

function accessStorageKey(token: string) {
  return `telegram-drive:share-access:${token}`;
}

export function PublicSharePageV2({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShareView | null>(null);
  const [selected, setSelected] = useState<TelegramFile | null>(null);
  const [accessKey, setAccessKey] = useState<string | null>(() => {
    try {
      return window.sessionStorage.getItem(accessStorageKey(token));
    } catch {
      return null;
    }
  });
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [lockedExpiresAt, setLockedExpiresAt] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadShare = async (key: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const value = await publicShareApi.get(token, key);
      setShare(value);
      setPasswordRequired(false);
      setLockedExpiresAt(value.expires_at);
      if (value.kind === 'file' && value.file) setSelected(value.file);
    } catch (err) {
      if (err instanceof PublicSharePasswordRequiredError) {
        setShare(null);
        setPasswordRequired(true);
        setLockedExpiresAt(err.expiresAt);
        if (key) {
          try { window.sessionStorage.removeItem(accessStorageKey(token)); } catch { /* noop */ }
          setAccessKey(null);
        }
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not open this share link');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadShare(accessKey);
    // token/accessKey intentionally reload the public capability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, accessKey]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password.trim()) return;
    try {
      setUnlocking(true);
      setError(null);
      const result = await publicShareApi.unlock(token, password);
      try { window.sessionStorage.setItem(accessStorageKey(token), result.access_key); } catch { /* noop */ }
      setPassword('');
      setAccessKey(result.access_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock this share');
    } finally {
      setUnlocking(false);
    }
  };

  const files = useMemo(() => {
    if (!share) return [];
    if (share.kind === 'file') return share.file ? [share.file] : [];
    return share.files || [];
  }, [share]);

  if (loading) {
    return (
      <PublicShell>
        <div className="flex min-h-[65vh] flex-col items-center justify-center gap-4 text-slate-300">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-cyan-400 border-t-transparent" />
          <p className="text-sm">Opening secure share...</p>
        </div>
      </PublicShell>
    );
  }

  if (passwordRequired) {
    return (
      <PublicShell>
        <div className="mx-auto flex min-h-[76vh] max-w-lg items-center justify-center p-5">
          <form onSubmit={unlock} className="w-full rounded-[32px] border border-cyan-300/15 bg-white/[0.045] p-6 shadow-2xl backdrop-blur-xl sm:p-8">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
              <LockKeyhole className="h-7 w-7" />
            </div>
            <div className="mt-5 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Protected share</div>
              <h1 className="mt-2 text-2xl font-semibold text-white">Enter share password</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                This owner protected the shared file or folder with an extra password.
              </p>
            </div>
            <label className="mt-6 block">
              <span className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200"><KeyRound className="h-4 w-4 text-cyan-300" /> Password</span>
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter password"
                className="w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/60"
              />
            </label>
            {error && <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
            <button disabled={unlocking || !password.trim()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-4 py-3.5 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">
              <LockKeyhole className="h-4 w-4" /> {unlocking ? 'Unlocking...' : 'Unlock share'}
            </button>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Clock3 className="h-3.5 w-3.5" /> {formatExpiry(lockedExpiresAt)}
            </div>
          </form>
        </div>
      </PublicShell>
    );
  }

  if (error || !share) {
    return (
      <PublicShell>
        <div className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center p-5">
          <div className="w-full rounded-3xl border border-red-400/20 bg-red-500/[0.07] p-7 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-red-500/10 text-red-300"><AlertTriangle className="h-7 w-7" /></div>
            <h1 className="mt-5 text-xl font-semibold text-white">Share unavailable</h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">{error || 'This link may have expired or been revoked.'}</p>
          </div>
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <header className="border-b border-white/10 bg-[#0b1420]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-cyan-400/10 text-cyan-300">
              {share.kind === 'folder' ? <FolderOpen className="h-5 w-5" /> : <File className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300"><ShieldCheck className="h-3.5 w-3.5" /> Read-only share</div>
              <h1 className="mt-1 truncate text-xl font-semibold text-white sm:text-2xl">{share.label}</h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-400"><Clock3 className="h-4 w-4 text-cyan-300" />{formatExpiry(share.expires_at)}</div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
        {share.kind === 'file' && share.file ? (
          <div className="space-y-5">
            <FileDetails file={share.file} token={token} accessKey={accessKey} onPreview={() => setSelected(share.file)} />
            <div className="flex min-h-[56vh] items-center justify-center rounded-3xl border border-white/10 bg-black/15 p-3 sm:p-5">
              <PublicPreview file={share.file} token={token} accessKey={accessKey} />
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm text-slate-400">{files.length} {files.length === 1 ? 'file' : 'files'}</p>
              <p className="hidden text-xs text-slate-500 sm:block">Preview and download only</p>
            </div>
            {files.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 px-6 py-20 text-center text-slate-500">This shared folder is empty.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {files.map((file) => <PublicFileCard key={file.id} file={file} token={token} accessKey={accessKey} onOpen={() => setSelected(file)} />)}
              </div>
            )}
          </>
        )}
      </main>

      {share.kind === 'folder' && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-2 backdrop-blur-sm sm:p-5" onMouseDown={() => setSelected(null)}>
          <div className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b1420] shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{selected.name}</div><div className="mt-0.5 text-xs text-slate-500">{formatBytes(selected.size || 0)}</div></div>
              <div className="flex items-center gap-2">
                <a href={publicShareApi.mediaUrl(token, selected.id, true, accessKey)} className="flex h-10 items-center gap-2 rounded-xl bg-cyan-400 px-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"><Download className="h-4 w-4" /><span className="hidden sm:inline">Download</span></a>
                <button onClick={() => setSelected(null)} className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2 sm:p-4"><PublicPreview file={selected} token={token} accessKey={accessKey} /></div>
          </div>
        </div>
      )}
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-auto bg-[radial-gradient(circle_at_top_left,_#142238,_#08101d_52%,_#050810)] text-white">
      {children}
      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-xs text-slate-600 sm:px-6">Shared securely with Telegram Drive</footer>
    </div>
  );
}

function FileDetails({ file, token, accessKey, onPreview }: { file: TelegramFile; token: string; accessKey: string | null; onPreview: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><h2 className="truncate text-base font-semibold text-white">{file.name}</h2><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>{formatBytes(file.size || 0)}</span>{file.created_at && <span>{file.created_at}</span>}{file.mime_type && <span>{file.mime_type}</span>}</div></div>
      <div className="flex gap-2">
        <button onClick={onPreview} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/5 sm:flex-none"><Play className="h-4 w-4" /> Preview</button>
        <a href={publicShareApi.mediaUrl(token, file.id, true, accessKey)} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 sm:flex-none"><Download className="h-4 w-4" /> Download</a>
      </div>
    </div>
  );
}

function PublicFileCard({ file, token, accessKey, onOpen }: { file: TelegramFile; token: string; accessKey: string | null; onOpen: () => void }) {
  const mediaUrl = publicShareApi.mediaUrl(token, file.id, false, accessKey);
  return (
    <article className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] transition hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-white/[0.055]">
      <button onClick={onOpen} className="block w-full text-left">
        <div className="relative aspect-[4/3] overflow-hidden bg-[#101b28]">
          {isImage(file) ? <img src={mediaUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center"><FileTypeIcon file={file} />{isVideo(file) && <span className="absolute grid h-10 w-10 place-items-center rounded-full bg-black/65 text-white shadow-lg"><Play className="ml-0.5 h-5 w-5 fill-current" /></span>}</div>}
        </div>
        <div className="px-3 pb-2 pt-3"><h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-white">{file.name}</h3><div className="mt-1 text-xs text-slate-500">{formatBytes(file.size || 0)}</div></div>
      </button>
      <div className="px-3 pb-3"><a href={publicShareApi.mediaUrl(token, file.id, true, accessKey)} onClick={(event) => event.stopPropagation()} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-2 text-xs font-semibold text-slate-300 transition hover:border-cyan-400/30 hover:bg-cyan-400/10 hover:text-cyan-200"><Download className="h-3.5 w-3.5" /> Download</a></div>
    </article>
  );
}

function FileTypeIcon({ file }: { file: TelegramFile }) {
  const ext = extension(file);
  const common = 'h-12 w-12';
  if (isImage(file)) return <ImageIcon className={`${common} text-violet-300`} />;
  if (VIDEO_EXTENSIONS.has(ext)) return <Play className={`${common} text-cyan-300`} />;
  if (EXCEL_EXTENSIONS.has(ext)) return <FileSpreadsheet className={`${common} text-emerald-300`} />;
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return <FileArchive className={`${common} text-amber-300`} />;
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'ppt', 'pptx'].includes(ext)) return <FileText className={`${common} text-blue-300`} />;
  return <File className={`${common} text-slate-400`} />;
}

function PublicPreview({ file, token, accessKey }: { file: TelegramFile; token: string; accessKey: string | null }) {
  const url = publicShareApi.mediaUrl(token, file.id, false, accessKey);
  const ext = extension(file);

  if (isImage(file)) return <img src={url} alt={file.name} className="max-h-[78vh] max-w-full rounded-xl object-contain shadow-2xl" />;
  if (isVideo(file)) return <video src={url} controls playsInline preload="metadata" className="max-h-[78vh] max-w-full rounded-xl bg-black shadow-2xl" />;
  if (isAudio(file)) return <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center"><div className="flex justify-center"><FileTypeIcon file={file} /></div><div className="mt-4 text-sm font-semibold">{file.name}</div><audio src={url} controls preload="metadata" className="mt-5 w-full" /></div>;
  if (ext === 'pdf') return <iframe src={url} title={file.name} className="h-[78vh] w-full rounded-xl border-0 bg-white shadow-2xl" />;
  if (ext === 'docx') return <WordDocumentViewer file={file} activeFolderId={null} streamUrlOverride={url} />;
  if (EXCEL_EXTENSIONS.has(ext)) return <ExcelWorkbookViewer file={file} activeFolderId={null} streamUrlOverride={url} />;
  if (TEXT_EXTENSIONS.has(ext)) return <PublicTextPreview url={url} />;

  return (
    <div className="flex max-w-lg flex-col items-center rounded-3xl border border-white/10 bg-white/[0.04] px-8 py-12 text-center">
      <FileTypeIcon file={file} />
      <h3 className="mt-5 text-base font-semibold text-white">Preview not available</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">You can still download this file safely.</p>
      <a href={publicShareApi.mediaUrl(token, file.id, true, accessKey)} className="mt-5 flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950"><Download className="h-4 w-4" /> Download</a>
    </div>
  );
}

function PublicTextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Preview request failed (HTTP ${response.status})`);
        return response.text();
      })
      .then((value) => setText(value.slice(0, 2_000_000)))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load preview');
      });
    return () => controller.abort();
  }, [url]);

  if (error) return <div className="text-sm text-red-300">{error}</div>;
  if (text === null) return <div className="h-9 w-9 animate-spin rounded-full border-4 border-cyan-400 border-t-transparent" />;
  return <pre className="max-h-[78vh] w-full max-w-5xl overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white p-5 font-mono text-xs leading-6 text-slate-800 shadow-2xl sm:p-8 sm:text-sm">{text || 'This file is empty.'}</pre>;
}
