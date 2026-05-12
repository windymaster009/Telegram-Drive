import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
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

function delay(ms: number) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function parseFloodWaitSeconds(error: unknown) {
    const message = String(error);
    const match = message.match(/FLOOD_WAIT_(\d+)/);
    return match ? Number(match[1]) : 0;
}

export function useFileUpload(activeFolderId: number | null, store: Store | null) {
    const queryClient = useQueryClient();
    const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([]);
    const [processing, setProcessing] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [pausedUntil, setPausedUntil] = useState(0);
    const cancelledRef = useRef<Set<string>>(new Set());

    // Listen for progress events from Rust
    useEffect(() => {
        let unlisten: UnlistenFn | undefined;
        listen<ProgressPayload>('upload-progress', (event) => {
            setUploadQueue(q => q.map(i =>
                i.id === event.payload.id
                    ? { ...i, progress: Math.max(i.progress ?? 0, event.payload.percent) }
                    : i
            ));
        }).then(fn => { unlisten = fn; });
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

    useEffect(() => {
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
        if (!store || !initialized) return;
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
            await invoke('cmd_upload_file_to_api', {
                path: item.path,
                folderId: item.folderId,
                transferId: item.id,
                apiBaseUrl: getApiBaseUrl(),
                accessToken: nasSession.getAccessToken(),
                csrfToken: nasSession.getCsrfToken(),
            });
            // Check if cancelled during upload
            if (cancelledRef.current.has(item.id)) {
                cancelledRef.current.delete(item.id);
            } else {
                setUploadQueue(q => q.map(i => i.id === item.id ? { ...i, status: 'success', progress: 100 } : i));
                queryClient.invalidateQueries({ queryKey: ['files', item.folderId] });
            }
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
            }
        } finally {
            await delay(UPLOAD_SPACING_MS);
            setProcessing(false);
        }
    };

    const handleManualUpload = async () => {
        try {
            const selected = await open({ multiple: true, directory: false });
            if (selected) {
                const selectedPaths = Array.isArray(selected) ? selected : [selected];
                const activeCount = uploadQueue.filter(item => item.status === 'pending' || item.status === 'uploading').length;
                const availableSlots = Math.max(0, MAX_QUEUED_UPLOADS - activeCount);
                if (availableSlots === 0) {
                    toast.error(`Upload queue is full. Keep it under ${MAX_QUEUED_UPLOADS} files.`);
                    return;
                }
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
            }
        } catch {
            toast.error("Failed to open file dialog");
        }
    };

    const cancelAll = () => {
        setUploadQueue(q => {
            const uploading = q.find(i => i.status === 'uploading');
            if (uploading) cancelledRef.current.add(uploading.id);
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
