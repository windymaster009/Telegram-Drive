import { useEffect, useMemo, useRef, useState } from 'react';
import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';
import { FileTypeIcon } from '../FileTypeIcon';

const MAX_ACTIVE_VIDEO_PREVIEWS = 2;
const DB_NAME = 'telegram-drive-preview-cache';
const DB_VERSION = 1;
const STORE_NAME = 'video-thumbnails';
const CACHE_VERSION = 'v2';
const MAX_CACHED_THUMBNAILS = 240;
const THUMBNAIL_MAX_WIDTH = 480;
const THUMBNAIL_TIMEOUT_MS = 24_000;

type CachedThumbnail = {
    key: string;
    blob: Blob;
    savedAt: number;
};

type PreviewWaiter = {
    cancelled: boolean;
    resolve: (release: () => void) => void;
};

let activeVideoPreviews = 0;
const previewWaiters: PreviewWaiter[] = [];

function pumpPreviewQueue() {
    while (activeVideoPreviews < MAX_ACTIVE_VIDEO_PREVIEWS && previewWaiters.length > 0) {
        const waiter = previewWaiters.shift();
        if (!waiter || waiter.cancelled) continue;

        activeVideoPreviews += 1;
        let released = false;
        waiter.resolve(() => {
            if (released) return;
            released = true;
            activeVideoPreviews = Math.max(0, activeVideoPreviews - 1);
            pumpPreviewQueue();
        });
    }
}

function acquirePreviewSlot() {
    let waiter: PreviewWaiter | null = null;
    const promise = new Promise<() => void>((resolve) => {
        waiter = { cancelled: false, resolve };
        previewWaiters.push(waiter);
        pumpPreviewQueue();
    });

    return {
        promise,
        cancel: () => {
            if (waiter) waiter.cancelled = true;
        },
    };
}

function openPreviewDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open thumbnail cache'));
    });
}

async function readCachedThumbnail(key: string): Promise<Blob | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
        const db = await openPreviewDb();
        return await new Promise<Blob | null>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve((request.result as CachedThumbnail | undefined)?.blob || null);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => db.close();
            tx.onerror = () => db.close();
        });
    } catch {
        return null;
    }
}

async function writeCachedThumbnail(key: string, blob: Blob) {
    if (typeof indexedDB === 'undefined') return;
    try {
        const db = await openPreviewDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ key, blob, savedAt: Date.now() } satisfies CachedThumbnail);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });

        const entries = await new Promise<CachedThumbnail[]>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve((request.result || []) as CachedThumbnail[]);
            request.onerror = () => reject(request.error);
        });

        if (entries.length > MAX_CACHED_THUMBNAILS) {
            const stale = entries
                .sort((a, b) => a.savedAt - b.savedAt)
                .slice(0, entries.length - MAX_CACHED_THUMBNAILS);
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                stale.forEach((entry) => store.delete(entry.key));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        db.close();
    } catch {
        // Thumbnail caching is an optimization only; never break file browsing if storage is unavailable.
    }
}

async function nextPaint() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function captureVideoFrame(video: HTMLVideoElement): Promise<Blob | null> {
    return new Promise((resolve) => {
        if (!video.videoWidth || !video.videoHeight || video.readyState < video.HAVE_CURRENT_DATA) {
            resolve(null);
            return;
        }

        const scale = Math.min(1, THUMBNAIL_MAX_WIDTH / video.videoWidth);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
            resolve(null);
            return;
        }

        try {
            context.drawImage(video, 0, 0, width, height);
            canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.76);
        } catch {
            resolve(null);
        }
    });
}

function LoadingPlaceholder({ filename }: { filename: string }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-telegram-bg/30 p-3">
            <FileTypeIcon filename={filename} size="lg" />
            <div className="absolute bottom-3 right-3 h-4 w-4 animate-spin rounded-full border-2 border-telegram-primary/25 border-t-telegram-primary" />
        </div>
    );
}

function PlayOverlay() {
    return (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/20 via-transparent to-transparent">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-sm text-white shadow-lg backdrop-blur-sm">▶</div>
        </div>
    );
}

function thumbnailSeekTarget(video: HTMLVideoElement) {
    if (!Number.isFinite(video.duration) || video.duration <= 0.25) return 0;
    if (video.duration <= 2) return Math.max(0.12, video.duration * 0.35);
    return Math.min(2, Math.max(0.7, video.duration * 0.05));
}

export function FastVideoThumbnail({
    file,
    activeFolderId = null,
}: {
    file: TelegramFile;
    activeFolderId?: number | null;
}) {
    const releaseRef = useRef<(() => void) | null>(null);
    const objectUrlRef = useRef<string | null>(null);
    const capturingRef = useRef(false);
    const targetTimeRef = useRef(0);
    const seekAttemptedRef = useRef(false);
    const [posterUrl, setPosterUrl] = useState<string | null>(null);
    const [canLoadVideo, setCanLoadVideo] = useState(false);
    const [failed, setFailed] = useState(false);
    const [videoReady, setVideoReady] = useState(false);

    const streamUrl = useMemo(
        () => nasApi.streamUrl(activeFolderId ?? null, file.id),
        [activeFolderId, file.id]
    );
    const cacheKey = useMemo(
        () => `${CACHE_VERSION}:${activeFolderId ?? 'home'}:${file.id}:${file.size || 0}`,
        [activeFolderId, file.id, file.size]
    );

    const releaseSlot = () => {
        releaseRef.current?.();
        releaseRef.current = null;
    };

    useEffect(() => {
        let cancelled = false;
        let slot: ReturnType<typeof acquirePreviewSlot> | null = null;

        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
        setPosterUrl(null);
        setCanLoadVideo(false);
        setFailed(false);
        setVideoReady(false);
        capturingRef.current = false;
        targetTimeRef.current = 0;
        seekAttemptedRef.current = false;

        const start = async () => {
            const cached = await readCachedThumbnail(cacheKey);
            if (cancelled) return;
            if (cached) {
                const url = URL.createObjectURL(cached);
                objectUrlRef.current = url;
                setPosterUrl(url);
                return;
            }

            slot = acquirePreviewSlot();
            const release = await slot.promise;
            if (cancelled) {
                release();
                return;
            }
            releaseRef.current = release;
            setCanLoadVideo(true);
        };

        void start();

        return () => {
            cancelled = true;
            slot?.cancel();
            releaseSlot();
            if (objectUrlRef.current) {
                URL.revokeObjectURL(objectUrlRef.current);
                objectUrlRef.current = null;
            }
        };
    }, [cacheKey]);

    useEffect(() => {
        if (!canLoadVideo || posterUrl || failed) return;
        const timer = window.setTimeout(() => {
            releaseSlot();
            setFailed(true);
        }, THUMBNAIL_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [canLoadVideo, failed, posterUrl]);

    const finishFrame = async (video: HTMLVideoElement) => {
        if (capturingRef.current || posterUrl || failed) return;
        capturingRef.current = true;
        try {
            await nextPaint();
            const blob = await captureVideoFrame(video);
            if (blob) {
                const url = URL.createObjectURL(blob);
                if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
                objectUrlRef.current = url;
                setPosterUrl(url);
                void writeCachedThumbnail(cacheKey, blob);
                video.pause();
                video.removeAttribute('src');
                video.load();
            } else {
                setVideoReady(true);
            }
        } finally {
            releaseSlot();
            capturingRef.current = false;
        }
    };

    const prepareFrame = (video: HTMLVideoElement) => {
        if (seekAttemptedRef.current) return;
        seekAttemptedRef.current = true;
        const target = thumbnailSeekTarget(video);
        targetTimeRef.current = target;

        if (target <= 0.01) {
            void finishFrame(video);
            return;
        }

        try {
            video.currentTime = target;
        } catch {
            void finishFrame(video);
        }
    };

    const maybeCaptureLoadedFrame = (video: HTMLVideoElement) => {
        if (!seekAttemptedRef.current) return;
        const target = targetTimeRef.current;
        if (target <= 0.01 || Math.abs(video.currentTime - target) < 0.35) {
            void finishFrame(video);
        }
    };

    if (failed) {
        return (
            <div className="absolute inset-0 flex items-center justify-center bg-telegram-bg/25 p-3">
                <FileTypeIcon filename={file.name} size="lg" />
                <PlayOverlay />
            </div>
        );
    }

    if (posterUrl) {
        return (
            <>
                <img src={posterUrl} alt={`${file.name} thumbnail`} className="absolute inset-0 h-full w-full object-cover" />
                <PlayOverlay />
            </>
        );
    }

    return (
        <>
            {!videoReady && <LoadingPlaceholder filename={file.name} />}
            {canLoadVideo && (
                <video
                    src={streamUrl}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => prepareFrame(event.currentTarget)}
                    onSeeked={(event) => void finishFrame(event.currentTarget)}
                    onLoadedData={(event) => maybeCaptureLoadedFrame(event.currentTarget)}
                    onCanPlay={(event) => maybeCaptureLoadedFrame(event.currentTarget)}
                    onError={() => {
                        releaseSlot();
                        setFailed(true);
                    }}
                    className={`absolute inset-0 h-full w-full object-cover transition-opacity ${videoReady ? 'opacity-100' : 'opacity-0'}`}
                />
            )}
            {videoReady && <PlayOverlay />}
        </>
    );
}
