export function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] as const;
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'] as const;
const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac'] as const;

const endsWithAny = (name: string, exts: readonly string[]) => {
    const lower = name.toLowerCase();
    return exts.some(ext => lower.endsWith(`.${ext}`));
};

export const isAudioFile = (name: string, mimeType?: string | null) => {
    const normalizedMime = mimeType?.trim().toLowerCase();
    return Boolean(normalizedMime && AUDIO_MIME_TYPES.includes(normalizedMime as typeof AUDIO_MIME_TYPES[number]))
        || endsWithAny(name, AUDIO_EXTENSIONS);
};

export const isVideoFile = (name: string) => endsWithAny(name, VIDEO_EXTENSIONS);
export const isMediaFile = (name: string, mimeType?: string | null) => isAudioFile(name, mimeType) || isVideoFile(name);
export const isImageFile = (name: string) => endsWithAny(name, IMAGE_EXTENSIONS);
export const isPdfFile = (name: string) => name.toLowerCase().endsWith('.pdf');
export const isTextFile = (name: string) => endsWithAny(name, ['txt', 'md', 'log'] as const);
