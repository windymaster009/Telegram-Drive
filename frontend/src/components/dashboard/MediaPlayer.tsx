import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { TelegramFile } from '@shared/telegram';
import { isVideoFile } from '../../utils';
import { nasApi } from '../../lib/nasApi';

interface MediaPlayerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
}

export function MediaPlayer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId }: MediaPlayerProps) {
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retryNonce, setRetryNonce] = useState(0);

    const isVideo = isVideoFile(file.name);

    useEffect(() => {
        setLoading(true);
        setError(null);
        setRetryNonce(0);
        setPreviewUrl(nasApi.streamUrl(activeFolderId, file.id));
    }, [activeFolderId, file.id]);

    const markReady = () => {
        setLoading(false);
        setError(null);
    };

    const markError = () => {
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
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-white">Unsupported media type</div>
                    )}
                </div>

                <div className="mt-4 text-center">
                    <h3 className="text-lg font-medium text-white">{file.name}</h3>
                    <p className="text-sm text-white/50">
                        Streaming from Telegram Drive
                        {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                            <span className="ml-2">- {currentIndex + 1}/{totalItems}</span>
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}
