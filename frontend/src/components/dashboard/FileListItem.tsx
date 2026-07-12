import { useState } from 'react';
import { Folder, Eye, HardDrive, Plus } from 'lucide-react';
import type { TelegramFile } from '@shared/telegram';
import { FileTypeIcon } from '../FileTypeIcon';

interface FileListItemProps {
    file: TelegramFile;
    selectedIds: number[];
    onFileClick: (e: React.MouseEvent, id: number) => void;
    handleContextMenu: (e: React.MouseEvent, file: TelegramFile) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onPreview: (file: TelegramFile) => void;
    onDownload: (id: number, name: string) => void;
    onDelete: (id: number) => void;
    canWrite?: boolean;
}

export function FileListItem({
    file, selectedIds, onFileClick, handleContextMenu,
    onDragStart, onDragEnd, onDrop,
    onPreview, onDownload, onDelete,
    canWrite = true
}: FileListItemProps) {
    const [isDragOver, setIsDragOver] = useState(false);
    const isFolder = file.type === 'folder';

    return (
        <div
            onClick={(e) => onFileClick(e, file.id)}
            onContextMenu={(e) => handleContextMenu(e, file)}
            draggable={canWrite}
            onDragStart={(e) => {
                if (!canWrite) return;
                if (onDragStart) onDragStart(file.id);
                e.dataTransfer.setData("application/x-telegram-file-id", file.id.toString());
                e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
                if (onDragEnd) onDragEnd();
            }}
            onDragOver={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isDragOver) setIsDragOver(true);
                }
            }}
            onDragLeave={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                }
            }}
            onDrop={(e) => {
                if (isFolder && onDrop) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                    onDrop(e, file.id);
                }
            }}
            className={`group grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-transparent px-3 py-3 transition-all hover:bg-telegram-hover md:grid-cols-[2rem_minmax(0,2fr)_6rem_8rem] md:gap-4 md:px-4
                ${selectedIds.includes(file.id) ? 'bg-telegram-primary/10 border-telegram-primary/20' : ''}
                ${isDragOver ? 'ring-2 ring-telegram-primary bg-telegram-primary/20' : ''}
            `}
        >
            <div className="flex justify-center">
                {isFolder ? <Folder className="w-5 h-5 text-telegram-primary" /> : <FileTypeIcon filename={file.name} className="w-5 h-5" />}
            </div>
            <div className="relative truncate pr-8 text-sm font-medium text-telegram-text">
                {file.name}
                <div className="absolute right-0 top-1/2 hidden -translate-y-1/2 items-center rounded border border-telegram-border bg-telegram-surface px-1 opacity-0 shadow-lg group-hover:opacity-100 md:flex">
                    <button onClick={(e) => { e.stopPropagation(); onPreview(file) }} className="p-1 hover:text-telegram-text text-telegram-subtext" title="Preview"><Eye className="w-4 h-4" /></button>
                    <button onClick={(e) => { e.stopPropagation(); onDownload(file.id, file.name) }} className="p-1 hover:text-telegram-text text-telegram-subtext" title="Download"><HardDrive className="w-4 h-4" /></button>
                    {canWrite && <button onClick={(e) => { e.stopPropagation(); onDelete(file.id) }} className="p-1 hover:text-red-400 text-telegram-subtext" title="Delete"><Plus className="w-4 h-4 rotate-45" /></button>}
                </div>
            </div>
            <div className="hidden truncate text-right text-xs text-telegram-subtext md:block">{file.sizeStr}</div>
            <div className="hidden truncate text-right font-mono text-xs text-telegram-subtext opacity-50 md:block">{file.created_at || '-'}</div>
        </div>
    );
}
