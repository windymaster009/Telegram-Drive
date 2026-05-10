import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { TelegramFile } from '@shared/telegram';
import { isVideoFile, isAudioFile } from '../../utils';

interface MediaPlayerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
}

type StreamInfo = {
    token: string;
    base_url: string;
};

type LocalPreviewInfo = {
    id: string;
    file_path: string;
    tail_path: string | null;
    tail_start: number | null;
    file_name: string;
    mime_type: string;
    size: number;
};

type LocalPreviewStatus = {
    downloaded: number;
    size: number;
    complete: boolean;
    cancelled: boolean;
    error: string | null;
};

export function MediaPlayer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId }: MediaPlayerProps) {
    const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [progress, setProgress] = useState<LocalPreviewStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retryNonce, setRetryNonce] = useState(0);

    useEffect(() => {
        invoke<StreamInfo>('cmd_get_stream_info')
            .then(setStreamInfo)
            .catch((err) => {
                setError(String(err || 'Failed to initialize stream'));
                setLoading(false);
            });
    }, []);

    const isVideo = isVideoFile(file.name);
    const isAudio = isAudioFile(file.name);

    useEffect(() => {
        if (!streamInfo) return;

        let cancelled = false;
        let previewId: string | null = null;
        let pollTimer: number | null = null;

        const cancelPreview = (id: string) => {
            invoke('cmd_cancel_local_preview', { previewId: id }).catch(() => {
                // Best-effort cleanup; the backend also retries if the file is still open.
            });
        };

        setLoading(true);
        setError(null);
        setProgress(null);
        setPreviewUrl(null);
        setRetryNonce(0);

        invoke<LocalPreviewInfo>('cmd_start_local_preview', {
            messageId: file.id,
            folderId: activeFolderId
        }).then((info) => {
            previewId = info.id;
            if (cancelled) {
                cancelPreview(info.id);
                return;
            }

            const params = new URLSearchParams({
                token: streamInfo.token,
                path: info.file_path,
                size: String(info.size),
                mime: info.mime_type,
            });
            if (info.tail_path && info.tail_start !== null) {
                params.set('tail_path', info.tail_path);
                params.set('tail_start', String(info.tail_start));
            }
            const localUrl = `${streamInfo.base_url}/local-preview/${encodeURIComponent(info.id)}/${encodeURIComponent(info.file_name)}?${params.toString()}`;
            setPreviewUrl(localUrl);

            pollTimer = window.setInterval(() => {
                invoke<LocalPreviewStatus | null>('cmd_get_local_preview_status', { previewId: info.id })
                    .then((status) => {
                        if (!status || cancelled) return;
                        setProgress(status);
                        if (status.error) {
                            setError(status.error);
                            setLoading(false);
                        }
                        if (status.complete && pollTimer !== null) {
                            window.clearInterval(pollTimer);
                            pollTimer = null;
                        }
                    })
                    .catch(() => {});
            }, 500);
        }).catch((err) => {
            if (!cancelled) {
                setError(String(err || 'Failed to prepare local preview'));
                setLoading(false);
            }
        });

        const timer = window.setTimeout(() => {
            if (!cancelled) {
                setError("Preview timed out. Check Telegram connection or try again.");
                setLoading(false);
            }
        }, 90000);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            if (pollTimer !== null) window.clearInterval(pollTimer);
            if (previewId) cancelPreview(previewId);
        };
    }, [streamInfo, activeFolderId, file.id]);

    const markReady = () => {
        setLoading(false);
        setError(null);
    };

    const markError = () => {
        if (progress && !progress.complete) {
            setLoading(true);
            setError(null);
            window.setTimeout(() => {
                setRetryNonce((value) => value + 1);
            }, 1200);
            return;
        }

        setLoading(false);
        setError("Failed to load stream from backend.");
    };

    const mediaUrl = previewUrl ? `${previewUrl}&retry=${retryNonce}` : null;

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }

            const key = e.key.toLowerCase();

            if (e.key === 'ArrowRight' || key === 'l') {
                e.preventDefault();
                onNext?.();
                return;
            }

            if (e.key === 'ArrowLeft' || key === 'j') {
                e.preventDefault();
                onPrev?.();
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, onNext, onPrev]);

    return (
        <div className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md animate-in fade-in duration-200" onClick={onClose}>
            <div className="relative w-full max-w-6xl flex flex-col items-center" onClick={e => e.stopPropagation()}>
                <button
                    onClick={onPrev}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all z-10"
                    title="Previous (ArrowLeft / J)"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>

                <button
                    onClick={onNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all z-10"
                    title="Next (ArrowRight / L)"
                >
                    <ChevronRight className="w-6 h-6" />
                </button>

                <button
                    onClick={onClose}
                    className="absolute -top-12 right-0 p-2 text-white/50 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition-all"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center">
                    {!mediaUrl ? (
                        <div className="flex flex-col items-center gap-4 text-white">
                            <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>
                            <p>Preparing preview...</p>
                        </div>
                    ) : isVideo ? (
                        <>
                            <video
                                key={mediaUrl}
                                src={mediaUrl}
                                controls
                                autoPlay
                                preload="auto"
                                onLoadedMetadata={markReady}
                                onCanPlay={markReady}
                                onError={markError}
                                className="w-full h-full object-contain"
                            />
                            {(loading || error) && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 text-white">
                                    {loading && <div className="w-10 h-10 border-4 border-telegram-primary border-t-transparent rounded-full animate-spin"></div>}
                                    <p>{error || "Loading stream..."}</p>
                                    {progress && progress.size > 0 && (
                                        <p className="text-xs text-white/50">{Math.round((progress.downloaded / progress.size) * 100)}% cached locally</p>
                                    )}
                                </div>
                            )}
                        </>
                    ) : isAudio ? (
                        <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-telegram-primary/20 to-black">
                            <div className="w-32 h-32 rounded-full bg-telegram-surface flex items-center justify-center mb-8 shadow-xl animate-pulse-slow">
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 text-telegram-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                            </div>
                            <audio
                                key={mediaUrl}
                                src={mediaUrl}
                                controls
                                autoPlay
                                preload="auto"
                                onLoadedMetadata={markReady}
                                onCanPlay={markReady}
                                onError={markError}
                                className="w-full max-w-md"
                            />
                            {error && <p className="mt-4 text-sm text-red-200">{error}</p>}
                        </div>
                    ) : (
                        <div className="text-white">Unsupported media type</div>
                    )}
                </div>

                <div className="mt-4 text-center">
                    <h3 className="text-lg font-medium text-white">{file.name}</h3>
                    <p className="text-sm text-white/50">
                        Streaming from Telegram Drive
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <span className="ml-2">• {currentIndex + 1}/{totalItems}</span>
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}
