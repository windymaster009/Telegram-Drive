import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Shield } from 'lucide-react';

import type { TelegramFile, BandwidthStats, TelegramFolder } from '@shared/telegram';
import type { AppUser, PermissionAssignment } from '@shared/nas';
import { formatBytes, isAudioFile, isPdfFile, isVideoFile } from '../utils';

// Components
import { Sidebar } from './dashboard/Sidebar';
import { TopBar } from './dashboard/TopBar';
import { FileExplorer } from './dashboard/FileExplorer';
import { UploadQueue } from './dashboard/UploadQueue';
import { DownloadQueue } from './dashboard/DownloadQueue';
import { MoveToFolderModal } from './dashboard/MoveToFolderModal';
import { PreviewModal } from './dashboard/PreviewModal';
import { MediaPlayer } from './dashboard/MediaPlayer';
import { DragDropOverlay } from './dashboard/DragDropOverlay';
import { ExternalDropBlocker } from './dashboard/ExternalDropBlocker';
import { PdfViewer } from './dashboard/PdfViewer';
import { FolderActionModal } from './dashboard/FolderActionModal';
import { FolderUnlockModal } from './dashboard/FolderUnlockModal';
import { SelectFolderState } from './dashboard/SelectFolderState';

// Hooks
import { useTelegramConnection } from '../hooks/useTelegramConnection';
import { useFileOperations } from '../hooks/useFileOperations';
import { useFileUpload } from '../hooks/useFileUpload';
import { useFileDownload } from '../hooks/useFileDownload';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { nasApi } from '../lib/nasApi';
import { useAudioPlayer } from '../context/AudioPlayerContext';

interface DashboardProps {
    onLogout: () => void;
    permissions?: PermissionAssignment[];
    allowFolderManagement?: boolean;
    adminControls?: {
        onAdminBack: () => void;
    };
    currentUser?: AppUser;
}

const isRootPermission = (folderId: string) => {
    const normalized = folderId.trim().toLowerCase();
    return normalized === "me" || normalized === "home" || normalized === "saved_messages" || normalized === "saved messages" || normalized === "null" || normalized === "root";
};

export function Dashboard({ onLogout, permissions, allowFolderManagement = true, adminControls, currentUser }: DashboardProps) {
    const queryClient = useQueryClient();
    const audioPlayer = useAudioPlayer();


    const {
        store, folders, activeFolderId, setActiveFolderId, isSyncing, isConnected,
        handleSyncFolders, handleCreateFolder, handleFolderDelete,
        handleFolderRename, handleFolderIconChange, handleFolderPassword
    } = useTelegramConnection(onLogout, currentUser);

    const isPermissionMode = !!permissions;
    const isAdmin = currentUser?.role === "admin" || !isPermissionMode;
    const permissionByFolder = useMemo(
        () => new Map(
            permissions?.map((permission) => [
                isRootPermission(permission.folder_id) ? "root" : permission.folder_id,
                permission,
            ]) || []
        ),
        [permissions]
    );
    const showSavedMessages = isAdmin;
    const visibleFolders: TelegramFolder[] = useMemo(
        () => {
            if (!isPermissionMode) return folders;

            const assignedFolders = permissions
                .filter((permission) => !isRootPermission(permission.folder_id))
                .reduce((map, permission) => {
                    const id = Number(permission.folder_id);
                    if (!Number.isFinite(id)) return map;
                    map.set(id, {
                        id,
                        name: permission.folder_label,
                        icon: permission.icon,
                        owner_id: permission.owner_id,
                        owner_name: permission.owner_name,
                        is_password_protected: Boolean(permission.is_password_protected),
                        can_manage: Boolean(permission.can_manage),
                    });
                    return map;
                }, new Map<number, TelegramFolder>());

            const byId = new Map<number, TelegramFolder>();
            for (const folder of folders) {
                const assigned = assignedFolders.get(folder.id);
                const isOwnedByCurrentUser = folder.owner_id === currentUser?.id;
                if (!assigned && !isOwnedByCurrentUser) continue;

                byId.set(folder.id, {
                    ...folder,
                    ...assigned,
                    is_password_protected: assigned?.is_password_protected ?? Boolean(folder.is_password_protected),
                    can_manage: Boolean(isOwnedByCurrentUser || assigned?.can_manage),
                });
            }

            for (const folder of assignedFolders.values()) {
                if (!byId.has(folder.id)) byId.set(folder.id, folder);
            }

            return Array.from(byId.values());
        },
        [currentUser?.id, folders, isPermissionMode, permissions]
    );
    const activePermission = isPermissionMode
        ? permissionByFolder.get(activeFolderId === null ? "root" : String(activeFolderId))
        : undefined;
    const activeFolder = activeFolderId === null
        ? undefined
        : visibleFolders.find((folder) => folder.id === activeFolderId) || (!isPermissionMode ? folders.find((folder) => folder.id === activeFolderId) : undefined);
    const canManageActiveFolder = activeFolderId === null
        ? isAdmin
        : Boolean(isAdmin || activeFolder?.can_manage);
    const canWrite = activeFolderId === null
        ? isAdmin
        : Boolean(isAdmin || activeFolder?.can_manage || activePermission?.access_level === "read_write");
    const writableFolders = useMemo(
        () => visibleFolders.filter((folder) => {
            const permission = permissionByFolder.get(String(folder.id));
            return Boolean(isAdmin || folder.can_manage || permission?.access_level === "read_write");
        }),
        [isAdmin, permissionByFolder, visibleFolders]
    );
    const canCopy = activeFolderId === null
        ? writableFolders.length > 0
        : Boolean(showSavedMessages || writableFolders.some((folder) => folder.id !== activeFolderId));
    const hasFolderAccess = !isPermissionMode || showSavedMessages || visibleFolders.length > 0;
    const activeFolderAllowed = !isPermissionMode || (activeFolderId === null
        ? showSavedMessages
        : visibleFolders.some((folder) => folder.id === activeFolderId));


    const [previewFile, setPreviewFile] = useState<TelegramFile | null>(null);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [folderTransferMode, setFolderTransferMode] = useState<'move' | 'copy' | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState<TelegramFile[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [internalDragFileId, _setInternalDragFileId] = useState<number | null>(null);
    const internalDragRef = useRef<number | null>(null);

    const setInternalDragFileId = (id: number | null) => {
        internalDragRef.current = id;
        _setInternalDragFileId(id);
    };
    const [playingFile, setPlayingFile] = useState<TelegramFile | null>(null);
    const [pdfFile, setPdfFile] = useState<TelegramFile | null>(null);
    const [folderAction, setFolderAction] = useState<{ action: 'rename' | 'icon' | 'password'; folder: TelegramFolder } | null>(null);
    const [folderUnlock, setFolderUnlock] = useState<TelegramFolder | null>(null);
    const [unlockError, setUnlockError] = useState<string | null>(null);
    const [unlockedFolders, setUnlockedFolders] = useState<Set<number>>(() => new Set());
    const [previewContextFiles, setPreviewContextFiles] = useState<TelegramFile[]>([]);
    const [previewContextIndex, setPreviewContextIndex] = useState(-1);
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

    useEffect(() => {
        if (store) {
            store.get<'grid' | 'list'>('viewMode').then((saved) => {
                if (saved) setViewMode(saved);
            });
        }
    }, [store]);

    useEffect(() => {
        if (store) {
            store.set('viewMode', viewMode).then(() => store.save());
        }
    }, [store, viewMode]);

    useEffect(() => {
        if (!isPermissionMode) return;

        const activeAllowed = activeFolderId === null
            ? showSavedMessages
            : visibleFolders.some((folder) => folder.id === activeFolderId);

        if (!activeAllowed) setActiveFolderId(null);
    }, [isPermissionMode, activeFolderId, showSavedMessages, visibleFolders, setActiveFolderId]);

    const needsFolderSelection = isPermissionMode && !showSavedMessages && activeFolderId === null;
    const activeFolderNeedsUnlock = Boolean(
        activeFolderId !== null
        && activeFolder?.is_password_protected
        && !canManageActiveFolder
        && !unlockedFolders.has(activeFolderId)
    );


    const { data: allFiles = [], isLoading, error } = useQuery({
        queryKey: ['files', activeFolderId],
        queryFn: () => nasApi.listTelegramFiles(activeFolderId).then(res => res.map(f => ({
            ...f,
            sizeStr: formatBytes(f.size),
            type: f.type || (f.name.endsWith('/') ? 'folder' : 'file')
        }))),
        enabled: !!store && hasFolderAccess && activeFolderAllowed && !activeFolderNeedsUnlock,
    });

    const displayedFiles = searchTerm.length > 2
        ? searchResults
        : allFiles.filter((f: TelegramFile) => f.name.toLowerCase().includes(searchTerm.toLowerCase()));

    const { data: bandwidth } = useQuery({
        queryKey: ['bandwidth'],
        queryFn: () => invoke<BandwidthStats>('cmd_get_bandwidth'),
        refetchInterval: 5000,
        enabled: !!store
    });


    const {
        handleDelete, handleBulkDelete, handleBulkDownload,
        handleBulkMove, handleBulkCopy, handleDownloadFolder, handleGlobalSearch

    } = useFileOperations(activeFolderId, selectedIds, setSelectedIds, displayedFiles);

    const { uploadQueue, setUploadQueue, handleManualUpload, cancelAll: cancelUploads, isDragging } = useFileUpload(activeFolderId, store);
    const { downloadQueue, queueDownload, clearFinished: clearDownloads, cancelAll: cancelDownloads } = useFileDownload(store);


    const handleSelectAll = useCallback(() => {
        setSelectedIds(displayedFiles.map(f => f.id));
    }, [displayedFiles]);

    const handleKeyboardDelete = useCallback(() => {
        if (!canWrite) return;
        if (selectedIds.length > 0) {
            handleBulkDelete();
        }
    }, [selectedIds, handleBulkDelete, canWrite]);

    const handleEscape = useCallback(() => {
        setSelectedIds([]);
        setSearchTerm("");
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
    }, []);

    const handleFocusSearch = useCallback(() => {
        const searchInput = document.querySelector('input[placeholder="Search files..."]') as HTMLInputElement;
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }, []);

    const handleEnter = useCallback(() => {
        if (selectedIds.length === 1) {
            const selected = displayedFiles.find(f => f.id === selectedIds[0]);
            if (selected) {
                if (selected.type === 'folder') {
                    setActiveFolderId(selected.id);
                } else {
                    handlePreview(selected, displayedFiles);
                }
            }
        }
    }, [selectedIds, displayedFiles, setActiveFolderId]);

    useKeyboardShortcuts({
        onSelectAll: handleSelectAll,
        onDelete: handleKeyboardDelete,
        onEscape: handleEscape,
        onSearch: handleFocusSearch,
        onEnter: handleEnter,
        enabled: !previewFile && !playingFile && !pdfFile && !folderTransferMode // Disable when modals are open
    });


    useEffect(() => {
        setSelectedIds([]);
        setFolderTransferMode(null);
        setSearchTerm("");
        setSearchResults([]);
        setPreviewFile(null);
        setPlayingFile(null);
        setPdfFile(null);
        setPreviewContextFiles([]);
        setPreviewContextIndex(-1);
    }, [activeFolderId]);


    useEffect(() => {
        if (searchTerm.length <= 2) {
            setSearchResults([]);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const results = await handleGlobalSearch(searchTerm);
            setSearchResults(results);
            setIsSearching(false);
        }, 500);

        return () => clearTimeout(timer);
    }, [searchTerm]);




    const handleFileClick = (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey) {
            setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
        } else {
            const file = displayedFiles.find(item => item.id === id);
            if (file && file.type !== 'folder' && isAudioFile(file.name, file.mime_type)) {
                setSelectedIds([id]);
                handlePreview(file, displayedFiles);
                return;
            }
            setSelectedIds([id]);
        }
    }

    const handleToggleSelection = useCallback((id: number) => {
        setSelectedIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id]);
    }, []);

    const handlePreview = (file: TelegramFile, orderedFiles?: TelegramFile[]) => {
        if (isAudioFile(file.name, file.mime_type)) {
            audioPlayer.playTrack(file, orderedFiles || displayedFiles, activeFolderId);
            setPreviewFile(null);
            setPlayingFile(null);
            setPdfFile(null);
            return;
        }

        const contextFiles = (orderedFiles || displayedFiles).filter((f) => f.type !== 'folder' && !isAudioFile(f.name, f.mime_type));
        const contextIndex = contextFiles.findIndex((f) => f.id === file.id);

        setPreviewContextFiles(contextFiles);
        setPreviewContextIndex(contextIndex);

        const isVideo = isVideoFile(file.name);
        const isPdf = isPdfFile(file.name);

        if (isVideo) {
            setPlayingFile(file);
            setPreviewFile(null);
            setPdfFile(null);
        } else if (isPdf) {
            setPdfFile(file);
            setPreviewFile(null);
            setPlayingFile(null);
        } else {
            setPreviewFile(file);
            setPlayingFile(null);
            setPdfFile(null);
        }
    };

    const navigatePreview = useCallback((step: 1 | -1) => {
        if (previewContextFiles.length === 0) return;

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) return;

        const currentIndex = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + step + previewContextFiles.length) % previewContextFiles.length;
        const nextFile = previewContextFiles[nextIndex];
        if (!nextFile) return;

        setPreviewContextIndex(nextIndex);

        const isVideo = isVideoFile(nextFile.name);
        const isPdf = isPdfFile(nextFile.name);

        if (isVideo) {
            setPlayingFile(nextFile);
            setPreviewFile(null);
            setPdfFile(null);
        } else if (isPdf) {
            setPdfFile(nextFile);
            setPreviewFile(null);
            setPlayingFile(null);
        } else {
            setPreviewFile(nextFile);
            setPlayingFile(null);
            setPdfFile(null);
        }
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleNextPreview = useCallback(() => {
        navigatePreview(1);
    }, [navigatePreview]);

    const handlePrevPreview = useCallback(() => {
        navigatePreview(-1);
    }, [navigatePreview]);

    const previewNeighborFiles = useCallback(() => {
        if (previewContextFiles.length === 0) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentFileId = previewFile?.id ?? playingFile?.id ?? pdfFile?.id;
        if (!currentFileId) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const currentIdx = previewContextFiles.findIndex((f) => f.id === currentFileId);
        if (currentIdx === -1) {
            return { nextFile: null as TelegramFile | null, prevFile: null as TelegramFile | null };
        }

        const nextIdx = (currentIdx + 1) % previewContextFiles.length;
        const prevIdx = (currentIdx - 1 + previewContextFiles.length) % previewContextFiles.length;

        return {
            nextFile: previewContextFiles[nextIdx] || null,
            prevFile: previewContextFiles[prevIdx] || null,
        };
    }, [previewContextFiles, previewFile, playingFile, pdfFile]);

    const handleDropOnFolder = async (e: React.DragEvent, targetFolderId: number | null) => {
        e.preventDefault();
        e.stopPropagation();

        if (!canWrite) {
            toast.error("This folder is read-only.");
            return;
        }

        const dataTransferFileId = e.dataTransfer.getData("application/x-telegram-file-id");

        if (activeFolderId === targetFolderId) return;

        const fileId = internalDragRef.current || (dataTransferFileId ? parseInt(dataTransferFileId) : null);

        if (fileId) {
            try {
                const idsToMove = selectedIds.includes(fileId) ? selectedIds : [fileId];

                await nasApi.moveTelegramFiles({
                    message_ids: idsToMove,
                    source_folder_id: activeFolderId,
                    target_folder_id: targetFolderId,
                });

                queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });

                if (selectedIds.includes(fileId)) setSelectedIds([]);

                toast.success(`Moved ${idsToMove.length} file(s).`);

                setInternalDragFileId(null);
            } catch {
                toast.error(`Failed to move file(s).`);
            }
        }
    }

    const currentFolderName = !hasFolderAccess
        ? "No folder assigned"
        : activeFolderId === null
        ? "Saved Messages"
        : visibleFolders.find(f => f.id === activeFolderId)?.name || folders.find(f => f.id === activeFolderId)?.name || "Folder";


    const handleRootDragOver = (e: React.DragEvent) => {
        if (canWrite && internalDragRef.current) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const handleRootDragEnter = (e: React.DragEvent) => {
        if (canWrite && internalDragRef.current) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
        }
    };

    const selectFolder = (folderId: number | null) => {
        if (folderId === null) {
            setIsMobileSidebarOpen(false);
            setActiveFolderId(null);
            return;
        }
        const folder = visibleFolders.find((item) => item.id === folderId) || folders.find((item) => item.id === folderId);
        const needsUnlock = folder?.is_password_protected && !isAdmin && !folder.can_manage && !unlockedFolders.has(folderId);
        if (needsUnlock && folder) {
            setUnlockError(null);
            setFolderUnlock(folder);
            return;
        }
        setIsMobileSidebarOpen(false);
        setActiveFolderId(folderId);
    };

    const unlockFolder = async (password: string) => {
        if (!folderUnlock) return;
        const { ok } = await nasApi.verifyTelegramFolderPassword(folderUnlock.id, password);
        if (!ok) {
            setUnlockError("Incorrect folder password.");
            return;
        }
        setUnlockedFolders((current) => new Set(current).add(folderUnlock.id));
        setActiveFolderId(folderUnlock.id);
        setFolderUnlock(null);
        setUnlockError(null);
    };

    const previewNeighbors = previewNeighborFiles();

    return (
        <div
            className="flex h-screen w-full overflow-hidden bg-telegram-bg relative"
            onClick={() => setSelectedIds([])}
            onDragOver={handleRootDragOver}
            onDragEnter={handleRootDragEnter}
        >

            {canWrite && <ExternalDropBlocker onUploadClick={handleManualUpload} />}

            <AnimatePresence>
                {folderTransferMode && (
                    <MoveToFolderModal
                        folders={writableFolders}
                        onClose={() => setFolderTransferMode(null)}
                        onSelect={(targetFolderId) => {
                            const close = () => setFolderTransferMode(null);
                            if (folderTransferMode === 'copy') {
                                handleBulkCopy(targetFolderId, close);
                            } else {
                                handleBulkMove(targetFolderId, close);
                            }
                        }}
                        activeFolderId={activeFolderId}
                        mode={folderTransferMode}
                        showSavedMessages={showSavedMessages}
                        key={`${folderTransferMode}-modal`}
                    />
                )}
                {playingFile && (
                    <MediaPlayer
                        file={playingFile}
                        onClose={() => setPlayingFile(null)}
                        onNext={handleNextPreview}
                        onPrev={handlePrevPreview}
                        currentIndex={previewContextIndex}
                        totalItems={previewContextFiles.length}
                        activeFolderId={activeFolderId}
                        key="media-player"
                    />
                )}
                {pdfFile && (
                    <PdfViewer
                        file={pdfFile}
                        onClose={() => setPdfFile(null)}
                        onNext={handleNextPreview}
                        onPrev={handlePrevPreview}
                        currentIndex={previewContextIndex}
                        totalItems={previewContextFiles.length}
                        activeFolderId={activeFolderId}
                        key="pdf-viewer"
                    />
                )}
                {canWrite && isDragging && internalDragFileId === null && <DragDropOverlay key="drag-drop-overlay" />}
                {folderAction && (
                    <FolderActionModal
                        key={`${folderAction.action}-${folderAction.folder.id}`}
                        action={folderAction.action}
                        folder={folderAction.folder}
                        onClose={() => setFolderAction(null)}
                        onRename={(name) => handleFolderRename(folderAction.folder.id, name)}
                        onChangeIcon={(icon) => handleFolderIconChange(folderAction.folder.id, icon)}
                        onSetPassword={(password) => handleFolderPassword(folderAction.folder.id, password)}
                    />
                )}
                {folderUnlock && (
                    <FolderUnlockModal
                        key={`unlock-${folderUnlock.id}`}
                        folder={folderUnlock}
                        error={unlockError}
                        onClose={() => {
                            setFolderUnlock(null);
                            setUnlockError(null);
                        }}
                        onUnlock={unlockFolder}
                    />
                )}
            </AnimatePresence>

            <Sidebar
                folders={visibleFolders}
                activeFolderId={activeFolderId}
                setActiveFolderId={selectFolder}
                mobileOpen={isMobileSidebarOpen}
                onCloseMobile={() => setIsMobileSidebarOpen(false)}
                onDrop={handleDropOnFolder}
                onDelete={handleFolderDelete}
                onRename={(id) => {
                    const folder = visibleFolders.find((item) => item.id === id) || folders.find((item) => item.id === id);
                    if (folder) setFolderAction({ action: 'rename', folder });
                }}
                onChangeIcon={(id) => {
                    const folder = visibleFolders.find((item) => item.id === id) || folders.find((item) => item.id === id);
                    if (folder) setFolderAction({ action: 'icon', folder });
                }}
                onSetPassword={(id) => {
                    const folder = visibleFolders.find((item) => item.id === id) || folders.find((item) => item.id === id);
                    if (folder) setFolderAction({ action: 'password', folder });
                }}
                onCreate={handleCreateFolder}
                isSyncing={isSyncing}
                isConnected={isConnected}
                onSync={handleSyncFolders}
                onLogout={onLogout}
                bandwidth={bandwidth || null}
                allowFolderManagement={allowFolderManagement}
                allowFolderCreation={Boolean(currentUser)}
                showSavedMessages={showSavedMessages}
                showSync={Boolean(currentUser)}
            />

            <main className="flex min-w-0 flex-1 flex-col" onClick={(e) => { if (e.target === e.currentTarget) setSelectedIds([]); }}>
                <TopBar
                    currentFolderName={currentFolderName}
                    selectedIds={selectedIds}
                    onOpenSidebar={() => setIsMobileSidebarOpen(true)}
                    onShowMoveModal={() => setFolderTransferMode('move')}
                    onShowCopyModal={() => setFolderTransferMode('copy')}
                    onBulkDownload={handleBulkDownload}
                    onBulkDelete={handleBulkDelete}
                    onDownloadFolder={handleDownloadFolder}
                    viewMode={viewMode}
                    setViewMode={setViewMode}
                    searchTerm={searchTerm}
                    onSearchChange={setSearchTerm}
                    canWrite={canWrite}
                    canCopy={canCopy}
                    extraActions={adminControls && (
                        <>
                            <div className="w-px h-6 bg-telegram-border mx-1"></div>
                            <button
                                onClick={adminControls.onAdminBack}
                                className="p-2 hover:bg-telegram-hover rounded-md text-telegram-subtext hover:text-telegram-text transition relative group"
                                title="Admin Console"
                            >
                                <Shield className="w-5 h-5" />
                                <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 text-[10px] bg-telegram-surface border border-telegram-border px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50 shadow-lg">
                                    Admin
                                </span>
                            </button>
                        </>
                    )}
                />
                {searchTerm.length > 2 && (
                    <div className="px-3 pt-3 pb-0 sm:px-6 sm:pt-4">
                        <h2 className="text-sm font-medium text-telegram-subtext">
                            Search Results for <span className="text-telegram-primary">"{searchTerm}"</span>
                        </h2>
                    </div>
                )}
                {needsFolderSelection ? (
                    <SelectFolderState />
                ) : (
                    <FileExplorer
                        files={displayedFiles}
                        loading={isLoading || isSearching}
                        error={error}
                        viewMode={viewMode}
                        selectedIds={selectedIds}
                        activeFolderId={activeFolderId}
                        onFileClick={handleFileClick}
                        onDelete={handleDelete}
                        onDownload={(id, name) => queueDownload(id, name, activeFolderId)}
                        onPreview={handlePreview}
                        onManualUpload={handleManualUpload}
                        onSelectionClear={() => setSelectedIds([])}
                        onToggleSelection={handleToggleSelection}
                        onDrop={handleDropOnFolder}
                        onDragStart={(fileId) => setInternalDragFileId(fileId)}
                        onDragEnd={() => setTimeout(() => setInternalDragFileId(null), 50)}
                        canWrite={canWrite}
                    />
                )}
            </main>

            {previewFile && (
                <PreviewModal
                    file={previewFile}
                    activeFolderId={activeFolderId}
                    onClose={() => setPreviewFile(null)}
                    onNext={handleNextPreview}
                    onPrev={handlePrevPreview}
                    currentIndex={previewContextIndex}
                    totalItems={previewContextFiles.length}
                    nextFile={previewNeighbors.nextFile}
                    prevFile={previewNeighbors.prevFile}
                />
            )}


            <UploadQueue
                items={uploadQueue}
                onClearFinished={() => setUploadQueue(q => q.filter(i => i.status !== 'success' && i.status !== 'error' && i.status !== 'cancelled'))}
                onCancelAll={cancelUploads}
            />
            <DownloadQueue
                items={downloadQueue}
                onClearFinished={clearDownloads}
                onCancelAll={cancelDownloads}
            />
        </div>
    );
}
