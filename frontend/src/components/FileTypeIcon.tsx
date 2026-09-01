import {
    File, FileText, FileImage, FileVideo, FileAudio,
    FileArchive, FileCode, FileSpreadsheet, Presentation,
    FileType
} from 'lucide-react';

type FileTypeInfo = {
    icon: typeof File;
    color: string;
    label: string;
    badge: string;
    badgeClass: string;
};

const extensionMap: Record<string, FileTypeInfo> = {
    // Images
    jpg: { icon: FileImage, color: 'text-pink-400', label: 'JPG', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },
    jpeg: { icon: FileImage, color: 'text-pink-400', label: 'JPEG', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },
    png: { icon: FileImage, color: 'text-pink-400', label: 'PNG', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },
    gif: { icon: FileImage, color: 'text-pink-400', label: 'GIF', badge: 'GIF', badgeClass: 'bg-pink-600 text-white' },
    webp: { icon: FileImage, color: 'text-pink-400', label: 'WEBP', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },
    svg: { icon: FileImage, color: 'text-pink-400', label: 'SVG', badge: 'SVG', badgeClass: 'bg-pink-600 text-white' },
    bmp: { icon: FileImage, color: 'text-pink-400', label: 'BMP', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },
    heic: { icon: FileImage, color: 'text-pink-400', label: 'HEIC', badge: 'IMG', badgeClass: 'bg-pink-600 text-white' },

    // Videos
    mp4: { icon: FileVideo, color: 'text-purple-400', label: 'MP4', badge: '▶', badgeClass: 'bg-purple-600 text-white' },
    mov: { icon: FileVideo, color: 'text-purple-400', label: 'MOV', badge: '▶', badgeClass: 'bg-purple-600 text-white' },
    avi: { icon: FileVideo, color: 'text-purple-400', label: 'AVI', badge: '▶', badgeClass: 'bg-purple-600 text-white' },
    mkv: { icon: FileVideo, color: 'text-purple-400', label: 'MKV', badge: '▶', badgeClass: 'bg-purple-600 text-white' },
    webm: { icon: FileVideo, color: 'text-purple-400', label: 'WEBM', badge: '▶', badgeClass: 'bg-purple-600 text-white' },
    m4v: { icon: FileVideo, color: 'text-purple-400', label: 'M4V', badge: '▶', badgeClass: 'bg-purple-600 text-white' },

    // Audio
    mp3: { icon: FileAudio, color: 'text-emerald-400', label: 'MP3', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },
    wav: { icon: FileAudio, color: 'text-emerald-400', label: 'WAV', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },
    flac: { icon: FileAudio, color: 'text-emerald-400', label: 'FLAC', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },
    aac: { icon: FileAudio, color: 'text-emerald-400', label: 'AAC', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },
    ogg: { icon: FileAudio, color: 'text-emerald-400', label: 'OGG', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },
    m4a: { icon: FileAudio, color: 'text-emerald-400', label: 'M4A', badge: '♫', badgeClass: 'bg-emerald-600 text-white' },

    // Documents - desktop-style app badges
    pdf: { icon: FileType, color: 'text-red-500', label: 'PDF', badge: 'PDF', badgeClass: 'bg-[#e81123] text-white' },
    doc: { icon: FileText, color: 'text-blue-500', label: 'DOC', badge: 'W', badgeClass: 'bg-[#185abd] text-white' },
    docx: { icon: FileText, color: 'text-blue-500', label: 'DOCX', badge: 'W', badgeClass: 'bg-[#185abd] text-white' },
    odt: { icon: FileText, color: 'text-blue-500', label: 'ODT', badge: 'W', badgeClass: 'bg-[#185abd] text-white' },
    txt: { icon: FileText, color: 'text-slate-500', label: 'TXT', badge: 'TXT', badgeClass: 'bg-slate-600 text-white' },
    rtf: { icon: FileText, color: 'text-blue-500', label: 'RTF', badge: 'W', badgeClass: 'bg-[#185abd] text-white' },
    md: { icon: FileText, color: 'text-slate-500', label: 'MD', badge: 'MD', badgeClass: 'bg-slate-700 text-white' },
    epub: { icon: FileText, color: 'text-amber-500', label: 'EPUB', badge: 'E', badgeClass: 'bg-amber-600 text-white' },

    // Spreadsheets
    xls: { icon: FileSpreadsheet, color: 'text-green-600', label: 'XLS', badge: 'X', badgeClass: 'bg-[#107c41] text-white' },
    xlsx: { icon: FileSpreadsheet, color: 'text-green-600', label: 'XLSX', badge: 'X', badgeClass: 'bg-[#107c41] text-white' },
    csv: { icon: FileSpreadsheet, color: 'text-green-600', label: 'CSV', badge: 'X', badgeClass: 'bg-[#107c41] text-white' },
    ods: { icon: FileSpreadsheet, color: 'text-green-600', label: 'ODS', badge: 'X', badgeClass: 'bg-[#107c41] text-white' },

    // Presentations
    ppt: { icon: Presentation, color: 'text-orange-600', label: 'PPT', badge: 'P', badgeClass: 'bg-[#d83b01] text-white' },
    pptx: { icon: Presentation, color: 'text-orange-600', label: 'PPTX', badge: 'P', badgeClass: 'bg-[#d83b01] text-white' },
    key: { icon: Presentation, color: 'text-orange-600', label: 'KEY', badge: 'P', badgeClass: 'bg-[#d83b01] text-white' },
    odp: { icon: Presentation, color: 'text-orange-600', label: 'ODP', badge: 'P', badgeClass: 'bg-[#d83b01] text-white' },

    // Archives / packages
    zip: { icon: FileArchive, color: 'text-yellow-600', label: 'ZIP', badge: 'ZIP', badgeClass: 'bg-yellow-400 text-slate-950' },
    rar: { icon: FileArchive, color: 'text-yellow-600', label: 'RAR', badge: 'RAR', badgeClass: 'bg-yellow-400 text-slate-950' },
    '7z': { icon: FileArchive, color: 'text-yellow-600', label: '7Z', badge: '7Z', badgeClass: 'bg-yellow-400 text-slate-950' },
    tar: { icon: FileArchive, color: 'text-yellow-600', label: 'TAR', badge: 'TAR', badgeClass: 'bg-yellow-400 text-slate-950' },
    gz: { icon: FileArchive, color: 'text-yellow-600', label: 'GZ', badge: 'GZ', badgeClass: 'bg-yellow-400 text-slate-950' },
    tgz: { icon: FileArchive, color: 'text-yellow-600', label: 'TGZ', badge: 'TGZ', badgeClass: 'bg-yellow-400 text-slate-950' },
    bz2: { icon: FileArchive, color: 'text-yellow-600', label: 'BZ2', badge: 'BZ2', badgeClass: 'bg-yellow-400 text-slate-950' },
    xz: { icon: FileArchive, color: 'text-yellow-600', label: 'XZ', badge: 'XZ', badgeClass: 'bg-yellow-400 text-slate-950' },
    iso: { icon: FileArchive, color: 'text-yellow-600', label: 'ISO', badge: 'ISO', badgeClass: 'bg-yellow-400 text-slate-950' },
    apk: { icon: FileArchive, color: 'text-lime-500', label: 'APK', badge: 'APK', badgeClass: 'bg-lime-600 text-white' },

    // Code / config
    js: { icon: FileCode, color: 'text-yellow-500', label: 'JS', badge: 'JS', badgeClass: 'bg-yellow-400 text-slate-950' },
    ts: { icon: FileCode, color: 'text-blue-500', label: 'TS', badge: 'TS', badgeClass: 'bg-blue-600 text-white' },
    jsx: { icon: FileCode, color: 'text-cyan-500', label: 'JSX', badge: 'JSX', badgeClass: 'bg-cyan-600 text-white' },
    tsx: { icon: FileCode, color: 'text-cyan-500', label: 'TSX', badge: 'TSX', badgeClass: 'bg-cyan-600 text-white' },
    py: { icon: FileCode, color: 'text-green-500', label: 'PY', badge: 'PY', badgeClass: 'bg-green-600 text-white' },
    rs: { icon: FileCode, color: 'text-orange-500', label: 'RS', badge: 'RS', badgeClass: 'bg-orange-600 text-white' },
    go: { icon: FileCode, color: 'text-cyan-500', label: 'GO', badge: 'GO', badgeClass: 'bg-cyan-600 text-white' },
    java: { icon: FileCode, color: 'text-red-500', label: 'JAVA', badge: 'JAVA', badgeClass: 'bg-red-600 text-white' },
    html: { icon: FileCode, color: 'text-orange-500', label: 'HTML', badge: 'HTML', badgeClass: 'bg-orange-600 text-white' },
    css: { icon: FileCode, color: 'text-blue-500', label: 'CSS', badge: 'CSS', badgeClass: 'bg-blue-600 text-white' },
    json: { icon: FileCode, color: 'text-yellow-500', label: 'JSON', badge: '{}', badgeClass: 'bg-yellow-400 text-slate-950' },
    xml: { icon: FileCode, color: 'text-orange-500', label: 'XML', badge: '<>', badgeClass: 'bg-orange-600 text-white' },
    yaml: { icon: FileCode, color: 'text-violet-500', label: 'YAML', badge: 'YML', badgeClass: 'bg-violet-600 text-white' },
    yml: { icon: FileCode, color: 'text-violet-500', label: 'YML', badge: 'YML', badgeClass: 'bg-violet-600 text-white' },
    sql: { icon: FileCode, color: 'text-sky-500', label: 'SQL', badge: 'SQL', badgeClass: 'bg-sky-600 text-white' },
    sh: { icon: FileCode, color: 'text-emerald-500', label: 'SH', badge: '$', badgeClass: 'bg-emerald-700 text-white' },
    ps1: { icon: FileCode, color: 'text-blue-500', label: 'PS1', badge: 'PS', badgeClass: 'bg-blue-700 text-white' },
    c: { icon: FileCode, color: 'text-blue-500', label: 'C', badge: 'C', badgeClass: 'bg-blue-700 text-white' },
    cpp: { icon: FileCode, color: 'text-blue-500', label: 'CPP', badge: 'C++', badgeClass: 'bg-blue-700 text-white' },
    h: { icon: FileCode, color: 'text-blue-500', label: 'H', badge: 'H', badgeClass: 'bg-blue-700 text-white' },
    hpp: { icon: FileCode, color: 'text-blue-500', label: 'HPP', badge: 'H++', badgeClass: 'bg-blue-700 text-white' },
    php: { icon: FileCode, color: 'text-indigo-500', label: 'PHP', badge: 'PHP', badgeClass: 'bg-indigo-600 text-white' },
};

function getExtension(filename: string): string {
    const lastSegment = filename.split('/').pop() || filename;
    const parts = lastSegment.split('.');
    if (parts.length < 2) return '';
    return parts.pop()?.toLowerCase() || '';
}

export function getFileTypeInfo(filename: string): FileTypeInfo {
    const ext = getExtension(filename);
    const label = ext ? ext.slice(0, 5).toUpperCase() : 'FILE';
    return extensionMap[ext] || {
        icon: File,
        color: 'text-slate-500',
        label,
        badge: label,
        badgeClass: 'bg-slate-600 text-white',
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
    lg: 'w-[4.5rem] h-[5.5rem]',
};

export function FileTypeIcon({ filename, className, size = 'md' }: FileTypeIconProps) {
    const { icon: Icon, color, label, badge, badgeClass } = getFileTypeInfo(filename);
    const sizeClass = className ?? sizeMap[size];

    // Keep list/table views compact. The richer desktop-style icon is used in grid view.
    if (className || size !== 'lg') {
        return <Icon className={`${sizeClass} ${color} pointer-events-none select-none`} />;
    }

    return (
        <div
            className={`${sizeClass} relative flex items-center justify-center pointer-events-none select-none`}
            aria-label={`${label} file`}
        >
            {/* White document sheet with a folded corner, similar to desktop file icons. */}
            <div className="relative h-[4.65rem] w-[3.65rem] rounded-[0.55rem] border border-slate-300/80 bg-gradient-to-b from-white to-slate-100 shadow-[0_5px_14px_rgba(0,0,0,0.22)]">
                <div className="absolute right-0 top-0 h-4 w-4 overflow-hidden rounded-bl-md rounded-tr-[0.5rem] border-b border-l border-slate-300 bg-slate-200">
                    <div className="absolute -bottom-2 -left-2 h-4 w-4 rotate-45 bg-white" />
                </div>
                <Icon className={`absolute left-1/2 top-[1.15rem] h-6 w-6 -translate-x-1/2 ${color}`} strokeWidth={1.8} />
                <div className="absolute inset-x-2 bottom-2 space-y-1 opacity-60">
                    <div className="h-[2px] rounded bg-slate-300" />
                    <div className="h-[2px] w-3/4 rounded bg-slate-300" />
                </div>
            </div>

            {/* App/type badge gives Word/Excel/PDF/ZIP-style recognition at a glance. */}
            <div className={`absolute bottom-0 left-0 flex h-7 min-w-7 items-center justify-center rounded-md border border-white/20 px-1.5 text-[10px] font-black leading-none shadow-md ${badgeClass}`}>
                {badge}
            </div>

            <span className="sr-only">{label}</span>
        </div>
    );
}
