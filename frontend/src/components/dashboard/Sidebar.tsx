import { useState } from 'react';
import { HardDrive, Folder, Plus, RefreshCw, LogOut, X } from 'lucide-react';
import { SidebarItem } from './SidebarItem';
import { BandwidthWidget } from './BandwidthWidget';
import type { TelegramFolder, BandwidthStats } from '@shared/telegram';

interface SidebarProps {
    folders: TelegramFolder[];
    activeFolderId: number | null;
    setActiveFolderId: (id: number | null) => void;
    onDrop: (e: React.DragEvent, folderId: number | null) => void;
    onDelete: (id: number, name: string) => void;
    onRename: (id: number, name: string) => void;
    onChangeIcon: (id: number) => void;
    onSetPassword: (id: number) => void;
    onCreate: (name: string) => Promise<void>;
    isSyncing: boolean;
    isConnected: boolean;
    onSync: () => void;
    onLogout: () => void;
    bandwidth: BandwidthStats | null;
    mobileOpen?: boolean;
    onCloseMobile?: () => void;
    allowFolderManagement?: boolean;
    allowFolderCreation?: boolean;
    showSync?: boolean;
    showSavedMessages?: boolean;
}

export function Sidebar({
    folders, activeFolderId, setActiveFolderId, onDrop, onDelete, onRename, onChangeIcon, onSetPassword, onCreate,
    isSyncing, isConnected, onSync, onLogout, bandwidth, mobileOpen = false, onCloseMobile,
    allowFolderManagement = true,
    allowFolderCreation = allowFolderManagement,
    showSync = true,
    showSavedMessages = true
}: SidebarProps) {
    const [showNewFolderInput, setShowNewFolderInput] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");

    const submitCreate = async () => {
        if (!newFolderName.trim()) return;
        try {
            await onCreate(newFolderName);
            setNewFolderName("");
            setShowNewFolderInput(false);
        } catch {
            // handled by parent
        }
    };

    return (
        <>
            {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onCloseMobile} />}
            <aside
                className={`fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-72 flex-col border-r border-telegram-border bg-telegram-surface transition-transform duration-200 md:static md:z-auto md:w-64 md:max-w-none md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 px-4 pb-4 pt-[calc(env(safe-area-inset-top,0px)+20px)]">
                    <div className="flex min-w-0 items-center gap-2">
                        <img src="/logo.svg" className="w-8 h-8 drop-shadow-lg" alt="Logo" />
                        <span className="truncate font-bold text-lg tracking-tight text-telegram-text">Telegram Drive</span>
                    </div>
                    <button
                        onClick={onCloseMobile}
                        className="rounded-md p-2 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text md:hidden"
                        title="Close folders"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <nav className="flex-1 min-h-0 space-y-1 overflow-y-auto px-2 py-3">
                    {showSavedMessages && (
                        <SidebarItem
                            icon={HardDrive}
                            label="Saved Messages"
                            active={activeFolderId === null}
                            onClick={() => setActiveFolderId(null)}
                            onDrop={(e: React.DragEvent) => onDrop(e, null)}
                            folderId={null}
                        />
                    )}
                    {folders.map(folder => (
                        <SidebarItem
                            key={folder.id}
                            icon={Folder}
                            label={folder.name}
                            folderIcon={folder.icon}
                            ownerName={folder.owner_name || folder.owner_id || undefined}
                            active={activeFolderId === folder.id}
                            onClick={() => setActiveFolderId(folder.id)}
                            onDrop={(e: React.DragEvent) => onDrop(e, folder.id)}
                            canManage={allowFolderManagement || Boolean(folder.can_manage)}
                            isPasswordProtected={Boolean(folder.is_password_protected)}
                            onChangeIcon={(allowFolderManagement || folder.can_manage) ? () => onChangeIcon(folder.id) : undefined}
                            onRename={(allowFolderManagement || folder.can_manage) ? () => onRename(folder.id, folder.name) : undefined}
                            onSetPassword={(allowFolderManagement || folder.can_manage) ? () => onSetPassword(folder.id) : undefined}
                            onDelete={(allowFolderManagement || folder.can_manage) ? () => onDelete(folder.id, folder.name) : undefined}
                            folderId={folder.id}
                        />
                    ))}
                </nav>

                {allowFolderCreation && (
                    <div className="border-b border-telegram-border px-2 pb-2">
                        {showNewFolderInput ? (
                            <div className="px-3 py-2">
                                <input
                                    autoFocus
                                    type="text"
                                    className="w-full rounded bg-white/10 px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-telegram-primary"
                                    placeholder="Folder Name"
                                    value={newFolderName}
                                    onChange={e => setNewFolderName(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && submitCreate()}
                                    onBlur={() => !newFolderName && setShowNewFolderInput(false)}
                                />
                            </div>
                        ) : (
                            <button
                                onClick={() => setShowNewFolderInput(true)}
                                className="w-full rounded-lg border border-dashed border-telegram-border px-3 py-2 text-sm font-medium text-telegram-subtext transition-colors hover:bg-telegram-hover hover:text-telegram-text"
                            >
                                <span className="flex items-center gap-3">
                                    <Plus className="w-4 h-4" />
                                    Create Folder
                                </span>
                            </button>
                        )}
                    </div>
                )}

                <div className="border-t border-telegram-border p-4">
                    <div className="flex items-center gap-2 text-xs text-telegram-subtext">
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                        <span>{isConnected ? 'Connected to Telegram' : 'Disconnected from Telegram'}</span>
                    </div>

                    <div className="mt-4 flex gap-2">
                        {showSync && (
                            <button
                                onClick={onSync}
                                disabled={isSyncing}
                                className={`flex-1 flex items-center justify-center gap-2 rounded-lg bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-500 transition-colors hover:bg-blue-500/20 hover:text-blue-600 ${isSyncing ? 'cursor-not-allowed opacity-50' : ''}`}
                                title="Scan for existing folders"
                            >
                                <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                                {isSyncing ? 'Syncing...' : 'Sync'}
                            </button>
                        )}
                        <button
                            onClick={onLogout}
                            className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20 hover:text-red-600"
                            title="Sign Out"
                        >
                            <LogOut className="w-3 h-3" />
                            Logout
                        </button>
                    </div>

                    {bandwidth && <BandwidthWidget bandwidth={bandwidth} />}
                </div>
            </aside>
        </>
    );
}
