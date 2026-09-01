import {
    File, FileText, FileImage, FileVideo, FileAudio,
    FileArchive, FileCode, FileSpreadsheet, Presentation,
    FileType
} from 'lucide-react';

type FileTypeInfo = {
    icon: typeof File;
    color: string;
    surface: string;
    label: string;
};

const extensionMap: Record<string, FileTypeInfo> = {
    // Images
    jpg: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'JPG' },
    jpeg: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'JPEG' },
    png: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'PNG' },
    gif: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'GIF' },
    webp: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'WEBP' },
    svg: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'SVG' },
    bmp: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'BMP' },
    heic: { icon: FileImage, color: 'text-pink-300', surface: 'bg-pink-500/10 border-pink-400/25', label: 'HEIC' },

    // Videos
    mp4: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'MP4' },
    mov: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'MOV' },
    avi: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'AVI' },
    mkv: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'MKV' },
    webm: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'WEBM' },
    m4v: { icon: FileVideo, color: 'text-purple-300', surface: 'bg-purple-500/10 border-purple-400/25', label: 'M4V' },

    // Audio
    mp3: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'MP3' },
    wav: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'WAV' },
    flac: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'FLAC' },
    aac: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'AAC' },
    ogg: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'OGG' },
    m4a: { icon: FileAudio, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'M4A' },

    // Documents
    pdf: { icon: FileType, color: 'text-red-300', surface: 'bg-red-500/10 border-red-400/25', label: 'PDF' },
    doc: { icon: FileText, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'DOC' },
    docx: { icon: FileText, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'DOCX' },
    odt: { icon: FileText, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'ODT' },
    txt: { icon: FileText, color: 'text-slate-300', surface: 'bg-slate-500/10 border-slate-400/25', label: 'TXT' },
    rtf: { icon: FileText, color: 'text-cyan-300', surface: 'bg-cyan-500/10 border-cyan-400/25', label: 'RTF' },
    md: { icon: FileText, color: 'text-slate-300', surface: 'bg-slate-500/10 border-slate-400/25', label: 'MD' },
    epub: { icon: FileText, color: 'text-amber-300', surface: 'bg-amber-500/10 border-amber-400/25', label: 'EPUB' },

    // Spreadsheets
    xls: { icon: FileSpreadsheet, color: 'text-green-300', surface: 'bg-green-500/10 border-green-400/25', label: 'XLS' },
    xlsx: { icon: FileSpreadsheet, color: 'text-green-300', surface: 'bg-green-500/10 border-green-400/25', label: 'XLSX' },
    csv: { icon: FileSpreadsheet, color: 'text-green-300', surface: 'bg-green-500/10 border-green-400/25', label: 'CSV' },
    ods: { icon: FileSpreadsheet, color: 'text-green-300', surface: 'bg-green-500/10 border-green-400/25', label: 'ODS' },

    // Presentations
    ppt: { icon: Presentation, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'PPT' },
    pptx: { icon: Presentation, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'PPTX' },
    key: { icon: Presentation, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'KEY' },
    odp: { icon: Presentation, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'ODP' },

    // Archives / packages
    zip: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'ZIP' },
    rar: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'RAR' },
    '7z': { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: '7Z' },
    tar: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'TAR' },
    gz: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'GZ' },
    tgz: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'TGZ' },
    bz2: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'BZ2' },
    xz: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'XZ' },
    iso: { icon: FileArchive, color: 'text-yellow-300', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'ISO' },
    apk: { icon: FileArchive, color: 'text-lime-300', surface: 'bg-lime-500/10 border-lime-400/25', label: 'APK' },

    // Code / config
    js: { icon: FileCode, color: 'text-yellow-200', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'JS' },
    ts: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'TS' },
    jsx: { icon: FileCode, color: 'text-cyan-300', surface: 'bg-cyan-500/10 border-cyan-400/25', label: 'JSX' },
    tsx: { icon: FileCode, color: 'text-cyan-300', surface: 'bg-cyan-500/10 border-cyan-400/25', label: 'TSX' },
    py: { icon: FileCode, color: 'text-green-300', surface: 'bg-green-500/10 border-green-400/25', label: 'PY' },
    rs: { icon: FileCode, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'RS' },
    go: { icon: FileCode, color: 'text-cyan-300', surface: 'bg-cyan-500/10 border-cyan-400/25', label: 'GO' },
    java: { icon: FileCode, color: 'text-red-300', surface: 'bg-red-500/10 border-red-400/25', label: 'JAVA' },
    html: { icon: FileCode, color: 'text-orange-300', surface: 'bg-orange-500/10 border-orange-400/25', label: 'HTML' },
    css: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'CSS' },
    json: { icon: FileCode, color: 'text-yellow-200', surface: 'bg-yellow-500/10 border-yellow-400/25', label: 'JSON' },
    xml: { icon: FileCode, color: 'text-orange-200', surface: 'bg-orange-500/10 border-orange-400/25', label: 'XML' },
    yaml: { icon: FileCode, color: 'text-violet-300', surface: 'bg-violet-500/10 border-violet-400/25', label: 'YAML' },
    yml: { icon: FileCode, color: 'text-violet-300', surface: 'bg-violet-500/10 border-violet-400/25', label: 'YML' },
    sql: { icon: FileCode, color: 'text-sky-300', surface: 'bg-sky-500/10 border-sky-400/25', label: 'SQL' },
    sh: { icon: FileCode, color: 'text-emerald-300', surface: 'bg-emerald-500/10 border-emerald-400/25', label: 'SH' },
    ps1: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'PS1' },
    c: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'C' },
    cpp: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'CPP' },
    h: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'H' },
    hpp: { icon: FileCode, color: 'text-blue-300', surface: 'bg-blue-500/10 border-blue-400/25', label: 'HPP' },
    php: { icon: FileCode, color: 'text-indigo-300', surface: 'bg-indigo-500/10 border-indigo-400/25', label: 'PHP' },
};

function getExtension(filename: string): string {
    const lastSegment = filename.split('/').pop() || filename;
    const parts = lastSegment.split('.');
    if (parts.length < 2) return '';
    return parts.pop()?.toLowerCase() || '';
}

export function getFileTypeInfo(filename: string): FileTypeInfo {
    const ext = getExtension(filename);
    return extensionMap[ext] || {
        icon: File,
        color: 'text-telegram-subtext',
        surface: 'bg-telegram-hover/60 border-telegram-border',
        label: ext ? ext.slice(0, 5).toUpperCase() : 'FILE',
    };
}

interface FileTypeIconProps {
    filename: string;
    className?: string;
    size?: 'sm' | 'md' | 'lg';
}

const sizeMap = {
    sm: 'w-5 h-5',
    md: 'w-10 h-10',
    lg: 'w-14 h-14',
};

export function FileTypeIcon({ filename, className, size = 'md' }: FileTypeIconProps) {
    const { icon: Icon, color, surface, label } = getFileTypeInfo(filename);
    const sizeClass = className ?? sizeMap[size];

    // Keep list/table views compact. The richer tile is used for the large
    // grid-card icon where the extension badge is easy to read.
    if (className || size !== 'lg') {
        return <Icon className={`${sizeClass} ${color} pointer-events-none select-none`} />;
    }

    return (
        <div
            className={`${sizeClass} relative flex items-center justify-center pointer-events-none select-none`}
            aria-label={`${label} file`}
        >
            <div className={`absolute inset-0 rounded-2xl border ${surface}`} />
            <Icon className={`relative z-[1] w-7 h-7 ${color}`} />
            <span
                className={`absolute -bottom-2 z-[2] min-w-[2.2rem] rounded-md border px-1.5 py-0.5 text-center text-[9px] font-bold leading-none tracking-wide shadow-sm ${surface} ${color}`}
            >
                {label}
            </span>
        </div>
    );
}
