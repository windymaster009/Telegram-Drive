import { useEffect, useRef } from 'react';
import { AlertCircle, ChevronDown, Loader2, Music, Pause, Play, SkipBack, SkipForward, Volume2, X } from 'lucide-react';
import { useAudioPlayer } from '../../context/AudioPlayerContext';

const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
};

export function AudioPlayer() {
    const audioRef = useRef<HTMLAudioElement>(null);
    const {
        currentTrack,
        queue,
        currentIndex,
        isPlaying,
        duration,
        currentTime,
        volume,
        loading,
        error,
        expanded,
        playNonce,
        play,
        pause,
        stop,
        next,
        previous,
        setVolume,
        setExpanded,
        setPlaybackState,
    } = useAudioPlayer();

    const hasQueueControls = queue.length > 1;
    const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
    const seekValue = Math.min(currentTime, duration || currentTime);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.volume = volume;
    }, [volume]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || !currentTrack) return;

        if (audio.src !== currentTrack.sourceUrl) {
            audio.src = currentTrack.sourceUrl;
            audio.load();
        }

        if (isPlaying) {
            audio.play().catch(err => {
                setPlaybackState({
                    isPlaying: false,
                    loading: false,
                    error: err instanceof Error ? err.message : 'Playback failed.',
                });
            });
        } else {
            audio.pause();
        }
    }, [currentTrack, isPlaying, playNonce, setPlaybackState]);

    useEffect(() => {
        if (!currentTrack || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentTrack.name,
            artist: 'Telegram Drive',
            album: 'Telegram Drive',
        });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

        const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Some WebViews expose Media Session but not every action.
            }
        };

        setHandler('play', () => play());
        setHandler('pause', () => pause());
        setHandler('stop', () => stop());
        setHandler('previoustrack', hasQueueControls ? () => previous() : null);
        setHandler('nexttrack', hasQueueControls ? () => next() : null);
        setHandler('seekbackward', details => {
            const audio = audioRef.current;
            if (!audio) return;
            const step = typeof details.seekOffset === 'number' ? details.seekOffset : 10;
            const nextTime = Math.max(0, audio.currentTime - step);
            audio.currentTime = nextTime;
            setPlaybackState({ currentTime: nextTime });
        });
        setHandler('seekforward', details => {
            const audio = audioRef.current;
            if (!audio) return;
            const step = typeof details.seekOffset === 'number' ? details.seekOffset : 10;
            const maxTime = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number.MAX_SAFE_INTEGER;
            const nextTime = Math.min(maxTime, audio.currentTime + step);
            audio.currentTime = nextTime;
            setPlaybackState({ currentTime: nextTime });
        });
        setHandler('seekto', details => {
            const audio = audioRef.current;
            if (!audio || typeof details.seekTime !== 'number') return;
            audio.currentTime = details.seekTime;
            setPlaybackState({ currentTime: details.seekTime });
        });

        return () => {
            setHandler('play', null);
            setHandler('pause', null);
            setHandler('stop', null);
            setHandler('previoustrack', null);
            setHandler('nexttrack', null);
            setHandler('seekbackward', null);
            setHandler('seekforward', null);
            setHandler('seekto', null);
        };
    }, [currentTrack, hasQueueControls, isPlaying, next, pause, play, previous, setPlaybackState, stop]);

    useEffect(() => {
        if (!currentTrack || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
        if (!Number.isFinite(duration) || duration <= 0) return;
        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: audioRef.current?.playbackRate || 1,
                position: Math.min(currentTime, duration),
            });
        } catch {
            // Position state is optional in some embedded browsers.
        }
    }, [currentTrack, currentTime, duration]);

    if (!currentTrack) return null;

    const seekTo = (value: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = value;
        setPlaybackState({ currentTime: value });
    };

    const controls = (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={previous}
                disabled={!hasQueueControls}
                className="grid h-10 w-10 place-items-center rounded-full text-telegram-subtext transition hover:bg-white/10 hover:text-telegram-text disabled:opacity-35"
                title="Previous track"
            >
                <SkipBack className="h-5 w-5" />
            </button>
            <button
                type="button"
                onClick={isPlaying ? pause : play}
                className="grid h-12 w-12 place-items-center rounded-full bg-telegram-primary text-black shadow-lg transition hover:brightness-110"
                title={isPlaying ? 'Pause' : 'Play'}
            >
                {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
            </button>
            <button
                type="button"
                onClick={next}
                disabled={!hasQueueControls}
                className="grid h-10 w-10 place-items-center rounded-full text-telegram-subtext transition hover:bg-white/10 hover:text-telegram-text disabled:opacity-35"
                title="Next track"
            >
                <SkipForward className="h-5 w-5" />
            </button>
        </div>
    );

    return (
        <>
            <audio
                ref={audioRef}
                preload="metadata"
                onLoadedMetadata={event => setPlaybackState({ duration: event.currentTarget.duration || 0, loading: false, error: null })}
                onCanPlay={() => setPlaybackState({ loading: false, error: null })}
                onTimeUpdate={event => setPlaybackState({ currentTime: event.currentTarget.currentTime })}
                onDurationChange={event => setPlaybackState({ duration: event.currentTarget.duration || 0 })}
                onPlay={() => setPlaybackState({ isPlaying: true, loading: false })}
                onPause={() => setPlaybackState({ isPlaying: false })}
                onEnded={hasQueueControls ? next : stop}
                onWaiting={() => setPlaybackState({ loading: true })}
                onError={() => setPlaybackState({ loading: false, isPlaying: false, error: 'Could not play this audio stream.' })}
            />

            {expanded && (
                <div className="fixed inset-0 z-[260] flex items-end bg-black/70 backdrop-blur-sm md:hidden" onClick={() => setExpanded(false)}>
                    <div
                        className="w-full rounded-t-[28px] border border-white/10 bg-telegram-bg p-5 text-telegram-text shadow-2xl"
                        style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="mb-5 flex items-center justify-between">
                            <button type="button" onClick={() => setExpanded(false)} className="grid h-11 w-11 place-items-center rounded-full bg-white/8">
                                <ChevronDown className="h-5 w-5" />
                            </button>
                            <span className="text-xs font-medium uppercase text-telegram-subtext">Now Playing</span>
                            <button type="button" onClick={stop} className="grid h-11 w-11 place-items-center rounded-full bg-white/8">
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="mx-auto mb-6 grid h-44 w-44 place-items-center rounded-3xl border border-white/10 bg-gradient-to-br from-telegram-primary/25 to-telegram-surface">
                            <Music className="h-16 w-16 text-telegram-primary" />
                        </div>
                        <h2 className="line-clamp-2 text-center text-xl font-semibold">{currentTrack.name}</h2>
                        <p className="mt-2 text-center text-sm text-telegram-subtext">{queue.length > 1 ? `${currentIndex + 1} of ${queue.length}` : 'Telegram Drive'}</p>
                        <div className="mt-7">
                            <input
                                type="range"
                                min={0}
                                max={duration || 0}
                                step={0.1}
                                value={seekValue}
                                onChange={event => seekTo(Number(event.target.value))}
                                className="w-full accent-telegram-primary"
                                aria-label="Seek audio"
                            />
                            <div className="mt-2 flex justify-between text-xs text-telegram-subtext">
                                <span>{formatTime(currentTime)}</span>
                                <span>{formatTime(duration)}</span>
                            </div>
                        </div>
                        <div className="mt-6 flex justify-center">{controls}</div>
                        {error && <p className="mt-4 flex items-center justify-center gap-2 text-sm text-red-300"><AlertCircle className="h-4 w-4" /> {error}</p>}
                    </div>
                </div>
            )}

            <div
                className="fixed inset-x-0 bottom-0 z-[250] border-t border-white/10 bg-telegram-surface/95 px-3 py-3 text-telegram-text shadow-2xl backdrop-blur-xl md:px-5"
                style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
            >
                <div className="mx-auto flex max-w-7xl items-center gap-3">
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-telegram-primary md:pointer-events-none"
                        title="Open player"
                    >
                        <Music className="h-5 w-5" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-medium">{currentTrack.name}</p>
                            {error && <AlertCircle className="h-4 w-4 shrink-0 text-red-300" />}
                        </div>
                        <div className="mt-2 hidden items-center gap-3 md:flex">
                            <span className="w-10 text-xs text-telegram-subtext">{formatTime(currentTime)}</span>
                            <input
                                type="range"
                                min={0}
                                max={duration || 0}
                                step={0.1}
                                value={seekValue}
                                onChange={event => seekTo(Number(event.target.value))}
                                className="min-w-0 flex-1 accent-telegram-primary"
                                aria-label="Seek audio"
                            />
                            <span className="w-10 text-right text-xs text-telegram-subtext">{formatTime(duration)}</span>
                        </div>
                        <div className="mt-2 md:hidden">
                            <input
                                type="range"
                                min={0}
                                max={duration || 0}
                                step={0.1}
                                value={seekValue}
                                onChange={event => seekTo(Number(event.target.value))}
                                className="w-full accent-telegram-primary"
                                aria-label="Seek audio"
                            />
                            <div className="mt-1 flex justify-between text-[11px] text-telegram-subtext">
                                <span>{formatTime(currentTime)}</span>
                                <span>{formatTime(duration)}</span>
                            </div>
                            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                                <div className="h-full rounded-full bg-telegram-primary" style={{ width: `${progress}%` }} />
                            </div>
                        </div>
                    </div>
                    <div className="hidden md:flex">{controls}</div>
                    <div className="hidden items-center gap-2 md:flex">
                        <Volume2 className="h-4 w-4 text-telegram-subtext" />
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            onChange={event => setVolume(Number(event.target.value))}
                            className="w-24 accent-telegram-primary"
                            aria-label="Volume"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={isPlaying ? pause : play}
                        className="grid h-11 w-11 place-items-center rounded-full bg-telegram-primary text-black md:hidden"
                        title={isPlaying ? 'Pause' : 'Play'}
                    >
                        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
                    </button>
                    <button
                        type="button"
                        onClick={stop}
                        className="grid h-10 w-10 place-items-center rounded-full text-telegram-subtext transition hover:bg-white/10 hover:text-telegram-text"
                        title="Close player"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>
                {error && <p className="mx-auto mt-2 max-w-7xl truncate text-xs text-red-300 md:hidden">{error}</p>}
            </div>
        </>
    );
}
