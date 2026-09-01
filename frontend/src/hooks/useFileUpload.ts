import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QueueItem } from '@shared/telegram';
import { useFileDrop } from './useFileDrop';
import type { Store } from '@tauri-apps/plugin-store';
import { getApiBaseUrl, nasSession } from '../lib/nasApi';

interface ProgressPayload {
    id: string;
    percent: number;
}

const MAX_UPLOAD_BATCH_SIZE = 10;
const MAX_QUEUED_UPLOADS = 30;
const UPLOAD_SPACING_MS = 12_000;

const isTauriRuntime = () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function delay(ms: number) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function parseFloodWaitSeconds(error: unknown) {
    const message = String(error);
    const match = message.match(/FLOOD_WAIT_(\d+)/);
    return match ? Number(match[1]) : 0;
}

function pickBrowserFiles(): Promise<File[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);

        const finish = () => {
            const files = Array.from(input.files ?? []);
            input.remove();
            resolve(files);
        };

        input.addEventListener('change', finish, { once: true });
        input.addEventListener('cancel', finish, { once: true });
        input.click();
    });
}

async function uploadBrowserFile(file: File, folderId: number | null) {
    const params = new URLSearchParams({ file_name: file.name });
    if (folderId !== null) params.set('folder_id', String(folderId));

    const headers = new Headers();
    const accessToken = nasSession.getAccessToken();
    const csrfToken = nasSession.getCsrfToken();
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (csrfToken) headers.set('x-csrf-token', csrfToken);
    if (file.type) headers.set('Content-Type', file.type);

    const response = await fetch(`${getApiBaseUrl()}/api/telegram/upload?${params.toString()}`, {
        method: 'POST',
        headers,
        body: file,
        credentials: 'include',
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error || response.statusText || `Upload failed (${response.status})`);
    }

    return response.json().catch(() => ({}));
}

export function useFileUpload(activeFolderId: number | null, store: Store | null) {
    const queryClient = useQueryClient();
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [pausedUntil, setPausedUntil] = useState(0);
    const cancelledRef = useRef<Set<string>>(new Set());
    const browserFilesRef = useRef<Map<string, File>>(new Map());

    // Native progress events only exist in the Tauri desktop runtime.
    useEffect(() => {
        if (!isTauriRuntime()) return;

        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id
                    ? { ...i, progress: Math.max(i.progress ?? 0, event.payload.percent) }
                    : i
            ));
        }).then(fn => { unlisten = fn; }).catch(() => { });
        return () => { unlisten?.(); };
    }, []);

    useEffect(() => {
        const timer = window.setInterval(() => {
            setUploadQueue(q => q.map(item => {
                if (item.status !== 'uploading') return item;
                const current = item.progress ?? 0;
                if (current >= 95) return item;
                const step = current < 25 ? 4 : current < 70 ? 2 : 1;
                return { ...item, progress: Math.min(95, current + step) };
            }));
        }, 700);

        return () => window.clearInterval(timer);
    }, []);

    // Desktop can persist path-based pending uploads. Browser File objects cannot
    // survive a page reload, so browser queues intentionally stay in memory only.
    useEffect(() => {
        if (!isTauriRuntime()) {
            if (!initialized) setInitialized(true);
            return;
        }
        if (!store || initialized) return;
        store.get<QueueItem[]>('uploadQueue').then((saved) => {
            if (saved && saved.length > 0) {
                const pending = saved.filter(i => i.status === 'pending');
                if (pending.length > 0) {
                    setUploadQueue(pending);
                    toast.info(`Restored ${pending.length} pending uploads`);
                }
            }
            setInitialized(true);
        });
    }, [store, initialized]);

    useEffect(() => {
        if (!isTauriRuntime() || !store || !initialized) return;
        const pending = uploadQueue.filter(i => i.status === 'pending');
        store.set('uploadQueue', pending).then(() => store.save());
    }, [store, uploadQueue, initialized]);

    useEffect(() => {
        if (processing) return;
        if (pausedUntil > Date.now()) {
            const timer = window.setTimeout(() => setPausedUntil(0), pausedUntil - Date.now());
            return () => window.clearTimeout(timer);
        }
        const nextItem = uploadQueue.find(i => i.status === 'pending');
        if (nextItem) {
            processItem(nextItem);
        }
    }, [uploadQueue, processing, pausedUntil]);

    const processItem = async (item: QueueItem) => {
        setProcessing(true);
        setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'uploading', progress: 1 } : i));
        try {
            if (isTauriRuntime()) {
                await invoke('cmd_upload_file_to_api', {
                    path: item.path,
                    folderId: item.folderId,
                    transferId: item.id,
                    apiBaseUrl: getApiBaseUrl(),
                    accessToken: nasSession.getAccessToken(),
                    csrfToken: nasSession.getCsrfToken(),
                });
            } else {
                const file = browserFilesRef.current.get(item.id);
                if (!file) {
                    throw new Error('Selected browser file is no longer available. Please choose it again.');
                }
                await uploadBrowserFile(file, item.folderId);
            }

            // Check if cancelled during upload
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
            }
            browserFilesRef.current.delete(item.id);
        } catch (e) {
            if (!cancelledRef.current.has(item.id)) {
                const floodWaitSeconds = parseFloodWaitSeconds(e);
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'error', error: String(e) } : i));
                if (floodWaitSeconds > 0) {
                    const waitMs = Math.max(floodWaitSeconds * 1000, UPLOAD_SPACING_MS);
                    setPausedUntil(Date.now() + waitMs);
                    toast.error(`Telegram asked us to slow down. Uploads paused for about ${Math.ceil(waitMs / 60000)} minute(s).`);
                } else {
                    toast.error(`Upload failed for ${item.path.split('/').pop()}: ${e}`);
                }
            } else {
                cancelledRef.current.delete(item.id);
                browserFilesRef.current.delete(item.id);
            }
        } finally {
            await delay(UPLOAD_SPACING_MS);
            setProcessing(false);
        }
    };

    const handleManualUpload = async () => {
        try {
            const activeCount = uploadQueue.filter(item => item.status === 'pending' || item.status === 'uploading').length;
            const availableSlots = Math.max(0, MAX_QUEUED_UPLOADS - activeCount);
            if (availableSlots === 0) {
                toast.error(`Upload queue is full. Keep it under ${MAX_QUEUED_UPLOADS} files.`);
                return;
            }

            if (isTauriRuntime()) {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const selected = await open({ multiple: true, directory: false });
                if (!selected) return;

                const selectedPaths = Array.isArray(selected) ? selected : [selected];
                const paths = selectedPaths.slice(0, Math.min(MAX_UPLOAD_BATCH_SIZE, availableSlots));
                const newItems: QueueItem[] = paths.map((path: string) => ({
                    id: Math.random().toString(36).substr(2, 9),
                    path,
                    folderId: activeFolderId,
                    status: 'pending'
                }));
                setUploadQueue(prev => [...prev, ...newItems]);
                toast.info(`Queued ${paths.length} files for upload`);
                if (selectedPaths.length > paths.length) {
                    toast.info(`Only queued ${paths.length} files to keep upload activity gentle.`);
                }
                return;
            }

            const selectedFiles = await pickBrowserFiles();
            if (selectedFiles.length === 0) return;

            const files = selectedFiles.slice(0, Math.min(MAX_UPLOAD_BATCH_SIZE, availableSlots));
            const newItems: QueueItem[] = files.map((file) => {
                const id = Math.random().toString(36).substr(2, 9);
                browserFilesRef.current.set(id, file);
                return {
                    id,
                    path: file.name,
                    folderId: activeFolderId,
                    status: 'pending'
                };
            });

            setUploadQueue(prev => [...prev, ...newItems]);
            toast.info(`Queued ${files.length} files for upload`);
            if (selectedFiles.length > files.length) {
                toast.info(`Only queued ${files.length} files to keep upload activity gentle.`);
            }
        } catch (e) {
            toast.error(`Failed to open file dialog: ${String(e)}`);
        }
    };

    const cancelAll = () => {
        setUploadQueue(q => {
            const uploading = q.find(i => i.status === 'uploading');
            if (uploading) cancelledRef.current.add(uploading.id);
            for (const item of q) {
                if (item.status === 'pending') browserFilesRef.current.delete(item.id);
            }
            return q
                .filter(i => i.status !== 'pending')
                .map(i => i.status === 'uploading' ? { ...i, status: 'cancelled' as const } : i);
        });
        toast.info('All uploads cancelled');
    };

    const { isDragging } = useFileDrop();

    return {
        uploadQueue,
        setUploadQueue,
        handleManualUpload,
        cancelAll,
        isDragging
    };
}