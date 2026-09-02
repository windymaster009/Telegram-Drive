import { motion } from 'framer-motion';
import { useState } from 'react';
import { Folder, Eye, Trash2 } from 'lucide-react';
import type { TelegramFile } from '@shared/telegram';
import { FilePreview } from './FilePreview';

interface FileCardProps {
    file: TelegramFile;
    onDelete: () => void;
    onDownload: () => void;
    onPreview?: () => void;
    isSelected: boolean;
    onClick?: (e: React.MouseEvent) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
    onDragStart?: (fileId: number) => void;
    onDragEnd?: () => void;
    activeFolderId?: number | null;
    height?: number;
    onToggleSelection?: () => void;
    canWrite?: boolean;
}

export function FileCard({ file, onDelete, onDownload, onPreview, isSelected, onClick, onContextMenu, onDrop, onDragStart, onDragEnd, activeFolderId, height, onToggleSelection, canWrite = true }: FileCardProps) {
    const isFolder = file.type === 'folder';
    const [isDragOver, setIsDragOver] = useState(false);
    const displayDate = file.created_at?.trim() ? file.created_at.trim().slice(0, 10) : '';

    return (
        <div
            className="relative"
            onContextMenu={onContextMenu}
            onClick={onClick}
            onDoubleClick={(e) => {
                if (isFolder || (e.target as HTMLElement).closest('button')) return;
                e.preventDefault();
                e.stopPropagation();
                onPreview?.();
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
        >
            <motion.div
                layout
                draggable={!isFolder && canWrite}
                onDragStart={(e: any) => {
                    if (!canWrite) return;
                    if (onDragStart) onDragStart(file.id);
                    e.dataTransfer.setData('application/x-telegram-file-id', file.id.toString());
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => {
                    if (onDragEnd) onDragEnd();
                }}
                whileHover={{ y: -4 }}
                className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-telegram-surface transition-all hover:shadow-[0_4px_20px_rgba(0,0,0,0.2)]
                ${isSelected ? 'border-telegram-primary bg-telegram-primary/5 ring-1 ring-telegram-primary' : 'border-telegram-border hover:border-telegram-primary/50'}
                ${isDragOver ? 'ring-2 ring-telegram-primary bg-telegram-primary/20 scale-105' : ''}`}
                style={height ? { height: `${height}px` } : { aspectRatio: '4/3' }}
            >
                {/* Drive-style visual preview. Heavy previews are lazy-loaded near the viewport. */}
                <div className="relative min-h-0 flex-1 overflow-hidden bg-telegram-bg/35">
                    {isFolder ? (
                        <div className="absolute inset-0 flex items-center justify-center p-3">
                            <Folder className="h-14 w-14 text-telegram-primary" />
                        </div>
                    ) : (
                        <FilePreview file={file} activeFolderId={activeFolderId ?? null} />
                    )}
                </div>

                {/* Dedicated info footer so names never cover the preview. */}
                <div className="shrink-0 border-t border-telegram-border/70 bg-telegram-surface px-3 py-2.5">
                    <h3
                        className="overflow-hidden break-words text-sm font-semibold leading-[1.15rem] text-telegram-text"
                        style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            minHeight: '1.15rem',
                        }}
                        title={file.name}
                    >
                        {file.name}
                    </h3>
                    <p className="mt-1 truncate text-xs text-telegram-subtext">
                        {file.sizeStr}{displayDate ? ` · ${displayDate}` : ''}
                    </p>
                </div>

                {/* Selection Checkmark */}
                <div
                    onClick={(e) => {
                        e.stopPropagation();
                        if (onToggleSelection) onToggleSelection();
                    }}
                    className={`absolute left-2 top-2 z-10 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-all ${isSelected ? 'border-telegram-primary bg-telegram-primary' : 'border-white/50 bg-black/30 opacity-0 group-hover:opacity-100'}`}
                >
                    {isSelected && <div className="h-1.5 w-1.5 rounded-full bg-black" />}
                </div>

                {/* Quick actions on hover */}
                <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={(e) => { e.stopPropagation(); if (onPreview) onPreview(); }} className="file-action-btn rounded-full bg-black/50 p-1 text-white/70 hover:bg-telegram-primary hover:text-white" title="Preview">
                        <Eye className="h-3 w-3" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDownload(); }} className="file-action-btn rounded-full bg-black/50 p-1 text-white/70 hover:bg-green-500 hover:text-white" title="Download">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </button>
                    {canWrite && (
                        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="file-action-btn rounded-full bg-black/50 p-1 text-white/70 hover:bg-red-500 hover:text-white" title="Delete">
                            <Trash2 className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </motion.div>
        </div>
    );
}
