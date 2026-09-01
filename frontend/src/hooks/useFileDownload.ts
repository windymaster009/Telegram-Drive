import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { DownloadItem, TelegramFile } from '@shared/telegram';
import type { Store } from '@tauri-apps/plugin-store';
import { getApiBaseUrl, nasApi, nasSession } from '../lib/nasApi';

interface ProgressPayload {
    id: string;
    percent: number;
}

const isTauriRuntime = () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useFileDownload(store: Store | null) {
    const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const cancelledRef = useRef<Set<string>>(new Set());

    // Desktop/Tauri progress events. Browser downloads report progress directly.
    useEffect(() => {
        if (!isTauriRuntime()) return;

        let unlisten: (() => void) | undefined;
        let cancelled = false;

        import('@tauri-apps/api/event').then(({ listen }) =>
            listen<ProgressPayload>('download-progress', (event) => {
                setDownloadQueue(q => q.map(i =>
                    i.id === event.payload.id
                        ? { ...i, progress: Math.max(i.progress ?? 0, event.payload.percent) }
                        : i
                ));
            })
        ).then(fn => {
            if (cancelled) fn();
            else unlisten = fn;
        }).catch(() => undefined);

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        const timer = window.setInterval(() => {
            setDownloadQueue(q => q.map(item => {
                if (item.status !== 'downloading') return item;
                const current = item.progress ?? 0;
                if (current >= 95) return item;
                const step = current < 25 ? 4 : current < 70 ? 2 : 1;
                return { ...item, progress: Math.min(95, current + step) };
            }));
        }, 700);

        return () => window.clearInterval(timer);
    }, []);

    // Desktop persists pending queue. Browser downloads are user-gesture driven,
    // so they intentionally are not restored after a refresh.
    useEffect(() => {
        if (!isTauriRuntime()) {
            setInitialized(true);
            return;
        }
        if (!store || initialized) return;

        store.get<DownloadItem[]>('downloadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setDownloadQueue(pending);
                    toast.info(`Restored ${pending.length} pending downloads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    useEffect(() => {
        if (!isTauriRuntime() || !store || !initialized) return;
        const pending = downloadQueue.filter(i => i.status === 'pending');
        store.set('downloadQueue', pending).then(() => store.save());
    }, [store, downloadQueue, initialized]);

    // Desktop queue processor only. Browser starts downloads immediately from
    // the click handler so the native Save dialog keeps its user activation.
    useEffect(() => {
        if (!isTauriRuntime() || processing) return;
        const nextItem = downloadQueue.find(i => i.status === 'pending');
        if (nextItem) void processDesktopItem(nextItem);
    }, [downloadQueue, processing]);

    const updateProgress = (id: string, percent: number) => {
        setDownloadQueue(q => q.map(i =>
            i.id === id ? { ...i, progress: Math.max(i.progress ?? 0, Math.min(100, percent)) } : i
        ));
    };

    const processDesktopItem = async (item: DownloadItem) => {
        setProcessing(true);
        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'downloading', progress: 1 } : i));

        try {
            const [{ save }, { invoke }] = await Promise.all([
                import('@tauri-apps/plugin-dialog'),
                import('@tauri-apps/api/core'),
            ]);
            const savePath = await save({ defaultPath: item.filename });
            if (!savePath) {
                setDownloadQueue(q => q.filter(i => i.id !== item.id));
                return;
            }

            await invoke('cmd_download_file_from_api', {
                messageId: item.messageId,
                savePath,
                folderId: item.folderId,
                transferId: item.id,
                apiBaseUrl: getApiBaseUrl(),
                accessToken: nasSession.getAccessToken(),
            });

            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                toast.success(`Downloaded: ${item.filename}`);
            }
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(e) } : i));
                toast.error(`Download failed: ${item.filename}`);
            } else {
                cancelledRef.current.delete(item.id);
            }
        } finally {
            setProcessing(false);
        }
    };

    const streamResponseToWritable = async (
        response: Response,
        writable: any,
        item: DownloadItem
    ) => {
        if (!response.body) {
            await writable.write(await response.blob());
            updateProgress(item.id, 100);
            return;
        }

        const total = Number(response.headers.get('content-length')) || item.fileSize || 0;
        const reader = response.body.getReader();
        let received = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (cancelledRef.current.has(item.id)) {
                    await reader.cancel();
                    throw new DOMException('Download cancelled', 'AbortError');
                }
                await writable.write(value);
                received += value.byteLength;
                if (total > 0) updateProgress(item.id, Math.min(99, Math.round((received / total) * 100)));
            }
        } finally {
            reader.releaseLock();
        }
    };

    const processBrowserDownload = async (item: DownloadItem) => {
        let writable: any = null;
        let objectUrl: string | null = null;

        try {
            // Chromium/Edge: prompt immediately while this call still has a user gesture,
            // then stream Telegram bytes directly to disk.
            const picker = (window as any).showSaveFilePicker as undefined | ((options?: any) => Promise<any>);
            let fileHandle: any = null;
            if (typeof picker === 'function') {
                fileHandle = await picker({ suggestedName: item.filename });
            }

            setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'downloading', progress: 1 } : i));
            const response = await fetch(nasApi.streamUrl(item.folderId, item.messageId));
            if (!response.ok) throw new Error(`HTTP ${response.status} while downloading`);

            if (fileHandle) {
                writable = await fileHandle.createWritable();
                await streamResponseToWritable(response, writable, item);
                await writable.close();
                writable = null;
            } else {
                // Fallback for browsers without File System Access API.
                const blob = await response.blob();
                objectUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = objectUrl;
                anchor.download = item.filename;
                anchor.style.display = 'none';
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                updateProgress(item.id, 100);
            }

            setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
            toast.success(`Downloaded: ${item.filename}`);
        } catch (e) {
            const name = e instanceof DOMException ? e.name : '';
            if (name === 'AbortError') {
                setDownloadQueue(q => q.filter(i => i.id !== item.id));
                return;
            }
            setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(e) } : i));
            toast.error(`Download failed: ${item.filename}`);
        } finally {
            if (writable) {
                try { await writable.abort(); } catch { /* ignore cleanup errors */ }
            }
            if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
            cancelledRef.current.delete(item.id);
        }
    };

    const queueDownload = (messageId: number, filename: string, folderId: number | null) => {
        const newItem: DownloadItem = {
            id: Math.random().toString(36).slice(2, 11),
            messageId,
            filename,
            folderId,
            status: isTauriRuntime() ? 'pending' : 'downloading',
            progress: isTauriRuntime() ? 0 : 1,
        };
        setDownloadQueue(prev => [...prev, newItem]);

        if (!isTauriRuntime()) {
            // Do not await: invoking now preserves the browser click's user activation.
            void processBrowserDownload(newItem);
        }
    };

    const queueBulkDownload = async (files: TelegramFile[], folderId: number | null) => {
        if (!isTauriRuntime()) {
            const directoryPicker = (window as any).showDirectoryPicker as undefined | (() => Promise<any>);
            if (typeof directoryPicker !== 'function') {
                toast.info('Bulk folder download requires a Chromium-based browser. Download files individually on this browser.');
                return;
            }

            try {
                const directory = await directoryPicker();
                toast.info(`Downloading ${files.length} files...`);

                for (const file of files) {
                    const item: DownloadItem = {
                        id: Math.random().toString(36).slice(2, 11),
                        messageId: file.id,
                        filename: file.name,
                        folderId,
                        status: 'downloading',
                        progress: 1,
                    };
                    setDownloadQueue(prev => [...prev, item]);
                    try {
                        const handle = await directory.getFileHandle(file.name, { create: true });
                        const writable = await handle.createWritable();
                        const response = await fetch(nasApi.streamUrl(folderId, file.id));
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        await streamResponseToWritable(response, writable, item);
                        await writable.close();
                        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                    } catch (error) {
                        setDownloadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(error) } : i));
                    }
                }
            } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    toast.error('Bulk download failed');
                }
            }
            return;
        }

        const { open } = await import('@tauri-apps/plugin-dialog');
        const dirPath = await open({
            directory: true,
            multiple: false,
            title: 'Select Download Destination'
        });
        if (!dirPath) return;

        for (const file of files) {
            const newItem: DownloadItem = {
                id: Math.random().toString(36).slice(2, 11),
                messageId: file.id,
                filename: file.name,
                folderId,
                status: 'pending'
            };
            setDownloadQueue(prev => [...prev, newItem]);
        }

        toast.info(`Queued ${files.length} files for download`);
    };

    const clearFinished = () => {
        setDownloadQueue(q => q.filter(i => i.status !== 'success'));
    };

    const cancelAll = () => {
        setDownloadQueue(q => {
            q.filter(i => i.status === 'downloading').forEach(i => cancelledRef.current.add(i.id));
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'downloading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All downloads cancelled');
    };

    return {
        downloadQueue,
        queueDownload,
        queueBulkDownload,
        clearFinished,
        cancelAll
    };
}
