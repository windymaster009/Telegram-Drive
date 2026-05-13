import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TelegramFile } from '@shared/telegram';
import { isAudioFile } from '../utils';
import { nasApi } from '../lib/nasApi';

export interface AudioTrack {
    id: number;
    folderId: number | null;
    name: string;
    mimeType?: string | null;
    sourceUrl: string;
}

interface AudioPlayerState {
    currentTrack: AudioTrack | null;
    queue: AudioTrack[];
    currentIndex: number;
    isPlaying: boolean;
    duration: number;
    currentTime: number;
    volume: number;
    loading: boolean;
    error: string | null;
    expanded: boolean;
    playNonce: number;
}

interface AudioPlayerContextValue extends AudioPlayerState {
    playTrack: (file: TelegramFile, files: TelegramFile[], fallbackFolderId: number | null) => void;
    play: () => void;
    pause: () => void;
    stop: () => void;
    next: () => void;
    previous: () => void;
    setVolume: (volume: number) => void;
    setExpanded: (expanded: boolean) => void;
    setPlaybackState: (patch: Partial<Pick<AudioPlayerState, 'duration' | 'currentTime' | 'loading' | 'error' | 'isPlaying'>>) => void;
}

const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

const initialState: AudioPlayerState = {
    currentTrack: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    duration: 0,
    currentTime: 0,
    volume: 0.9,
    loading: false,
    error: null,
    expanded: false,
    playNonce: 0,
};

const folderForFile = (file: TelegramFile, fallbackFolderId: number | null) =>
    typeof file.folder_id === 'number' ? file.folder_id : fallbackFolderId;

const toTrack = (file: TelegramFile, fallbackFolderId: number | null): AudioTrack => {
    const folderId = folderForFile(file, fallbackFolderId);
    return {
        id: file.id,
        folderId,
        name: file.name,
        mimeType: file.mime_type,
        sourceUrl: nasApi.streamUrl(folderId, file.id),
    };
};

const sameTrack = (first: AudioTrack | null, second: AudioTrack | null) =>
    Boolean(first && second && first.id === second.id && first.folderId === second.folderId);

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AudioPlayerState>(initialState);

    const value = useMemo<AudioPlayerContextValue>(() => {
        const selectTrack = (queue: AudioTrack[], index: number, play = true) => {
            const track = queue[index];
            if (!track) return;
            setState(current => ({
                ...current,
                currentTrack: track,
                queue,
                currentIndex: index,
                isPlaying: play,
                loading: play,
                error: null,
                currentTime: sameTrack(current.currentTrack, track) ? current.currentTime : 0,
                duration: sameTrack(current.currentTrack, track) ? current.duration : 0,
                playNonce: current.playNonce + 1,
            }));
        };

        return {
            ...state,
            playTrack: (file, files, fallbackFolderId) => {
                const queue = files
                    .filter(item => item.type !== 'folder' && isAudioFile(item.name, item.mime_type))
                    .map(item => toTrack(item, fallbackFolderId));
                const requested = toTrack(file, fallbackFolderId);
                const index = queue.findIndex(track => sameTrack(track, requested));
                const nextQueue = queue.length > 0 ? queue : [requested];
                const nextIndex = index >= 0 ? index : 0;
                selectTrack(nextQueue, nextIndex, true);
            },
            play: () => setState(current => ({ ...current, isPlaying: true, playNonce: current.playNonce + 1 })),
            pause: () => setState(current => ({ ...current, isPlaying: false })),
            stop: () => setState(current => ({ ...initialState, volume: current.volume })),
            next: () => {
                if (state.queue.length === 0) return;
                const index = (state.currentIndex + 1) % state.queue.length;
                selectTrack(state.queue, index, true);
            },
            previous: () => {
                if (state.queue.length === 0) return;
                const index = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
                selectTrack(state.queue, index, true);
            },
            setVolume: volume => setState(current => ({ ...current, volume })),
            setExpanded: expanded => setState(current => ({ ...current, expanded })),
            setPlaybackState: patch => setState(current => ({ ...current, ...patch })),
        };
    }, [state]);

    return (
        <AudioPlayerContext.Provider value={value}>
            {children}
        </AudioPlayerContext.Provider>
    );
}

export function useAudioPlayer() {
    const context = useContext(AudioPlayerContext);
    if (!context) {
        throw new Error('useAudioPlayer must be used inside AudioPlayerProvider');
    }
    return context;
}
