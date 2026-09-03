import { HardDrive, LayoutGrid, Sun, Moon, Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTheme } from '../../context/ThemeContext';

interface TopBarProps {
    currentFolderName: string;
    selectedIds: number[];
    onOpenSidebar?: () => void;
    onShowMoveModal: () => void;
    onShowCopyModal: () => void;
    onBulkDownload: () => void;
    onBulkDelete: () => void;
    onDownloadFolder: () => void;
    viewMode: 'grid' | 'list';
    setViewMode: (mode: 'grid' | 'list') => void;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    canWrite?: boolean;
    canCopy?: boolean;
    extraActions?: ReactNode;
}

export function TopBar({
    currentFolderName, selectedIds, onOpenSidebar, onShowMoveModal, onShowCopyModal, onBulkDownload, onBulkDelete,
    onDownloadFolder, viewMode, setViewMode, searchTerm, onSearchChange,
    canWrite = true,
    canCopy = canWrite,
    extraActions
}: TopBarProps) {
    const { theme, toggleTheme } = useTheme();

    return (
        <header
            className="sticky top-0 z-10 border-b border-telegram-border bg-telegram-surface/90 px-3 pb-2.5 pt-[calc(env(safe-area-inset-top,0px)+12px)] backdrop-blur-xl sm:px-4 sm:py-0"
            onClick={e => e.stopPropagation()}
        >
            <div className="flex flex-col gap-2.5 sm:h-14 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="flex min-w-0 items-center gap-2 sm:flex-1 sm:gap-3">
                    {onOpenSidebar && (
                        <button
                            onClick={onOpenSidebar}
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text md:hidden"
                            title="Open folders"
                        >
                            <Menu className="h-5 w-5" />
                        </button>
                    )}
                    <div className="flex min-w-0 items-center text-sm text-telegram-subtext">
                        <span className="hidden cursor-pointer transition-colors hover:text-telegram-text sm:inline">Start</span>
                        <span className="mx-2 hidden sm:inline">/</span>
                        <span className="truncate text-base font-semibold text-telegram-text sm:text-sm sm:font-medium">{currentFolderName}</span>
                    </div>
                </div>

                <div className="w-full sm:max-w-md sm:flex-1 sm:px-4">
                    <input
                        type="text"
                        placeholder="Search files..."
                        className="w-full rounded-xl border border-telegram-border bg-telegram-hover px-3 py-2.5 text-sm text-telegram-text transition-colors placeholder:text-telegram-subtext focus:border-telegram-primary/50 focus:outline-none sm:rounded-lg sm:py-1.5"
                        value={searchTerm}
                        onChange={(e) => onSearchChange(e.target.value)}
                    />
                </div>

                <div className="flex min-w-0 items-center gap-2 sm:justify-end">
                    {selectedIds.length > 0 && (
                        <div className="animate-in fade-in slide-in-from-top-2 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5 sm:mr-2 sm:flex-none sm:overflow-visible sm:pb-0">
                            <span className="shrink-0 text-xs text-telegram-subtext">{selectedIds.length} Selected</span>
                            {canWrite && <button onClick={onShowMoveModal} className="shrink-0 rounded-lg bg-telegram-primary/20 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/30">Move</button>}
                            {canCopy && <button onClick={onShowCopyModal} className="shrink-0 rounded-lg bg-telegram-primary/20 px-3 py-1.5 text-xs font-medium text-telegram-primary transition hover:bg-telegram-primary/30">Copy</button>}
                            <button onClick={onBulkDownload} className="shrink-0 rounded-lg bg-telegram-hover px-3 py-1.5 text-xs text-telegram-text transition hover:bg-telegram-border">Download</button>
                            {canWrite && <button onClick={onBulkDelete} className="shrink-0 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/20">Delete</button>}
                        </div>
                    )}

                    <div className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0 sm:gap-2">
                        <button onClick={onDownloadFolder} className="group relative grid h-9 w-9 place-items-center rounded-xl text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text sm:h-auto sm:w-auto sm:rounded-md sm:p-2" title="Download Folder">
                            <HardDrive className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
                            <span className="pointer-events-none absolute -bottom-8 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-telegram-border bg-telegram-surface px-2 py-1 text-[10px] shadow-lg transition-opacity group-hover:opacity-100 sm:block sm:opacity-0">
                                Download All Files
                            </span>
                        </button>

                        <button
                            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                            className="group relative grid h-9 w-9 place-items-center rounded-xl text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text sm:h-auto sm:w-auto sm:rounded-md sm:p-2"
                            title="Toggle Layout"
                        >
                            <LayoutGrid className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
                            <span className="pointer-events-none absolute -bottom-8 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-telegram-border bg-telegram-surface px-2 py-1 text-[10px] shadow-lg transition-opacity group-hover:opacity-100 sm:block sm:opacity-0">
                                {viewMode === 'grid' ? 'Switch to List' : 'Switch to Grid'}
                            </span>
                        </button>

                        <div className="mx-1 hidden h-6 w-px bg-telegram-border sm:block"></div>

                        <button
                            onClick={toggleTheme}
                            className="group relative grid h-9 w-9 place-items-center rounded-xl text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text sm:h-auto sm:w-auto sm:rounded-md sm:p-2"
                            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                        >
                            {theme === 'dark' ? <Sun className="h-[18px] w-[18px] sm:h-5 sm:w-5" /> : <Moon className="h-[18px] w-[18px] sm:h-5 sm:w-5" />}
                            <span className="pointer-events-none absolute -bottom-8 left-1/2 z-50 hidden -translate-x-1/2 whitespace-nowrap rounded border border-telegram-border bg-telegram-surface px-2 py-1 text-[10px] shadow-lg transition-opacity group-hover:opacity-100 sm:block sm:opacity-0">
                                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                            </span>
                        </button>

                        {extraActions}
                    </div>
                </div>
            </div>
        </header>
    );
}
