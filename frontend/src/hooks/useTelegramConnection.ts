import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Store } from '@tauri-apps/plugin-store';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import type { TelegramFolder } from '@shared/telegram';
import type { AppUser } from '@shared/nas';
import { useNetworkStatus } from './useNetworkStatus';
import { nasApi, nasSession } from '../lib/nasApi';

export function useTelegramConnection(onLogoutParent: () => void, currentUser?: AppUser) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();

    const [folders, setFolders] = useState<TelegramFolder[]>([]);
    const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
    const [store, setStore] = useState<Store | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isConnected, setIsConnected] = useState(false);


    const networkIsOnline = useNetworkStatus();


    useEffect(() => {
        const initStore = async () => {
            try {
                let _store = await Store.load('config.json');
                const checkId = await _store.get<string>('api_id');
                if (!checkId) {
                    _store = await Store.load('settings.json');
                }
                setStore(_store);

                const savedFolders = await _store.get<TelegramFolder[]>('folders');
                if (savedFolders) setFolders(savedFolders);


                const savedActiveFolderId = await _store.get<number | null>('activeFolderId');
                if (currentUser?.role === "user") {
                    setActiveFolderId(null);
                    await _store.set('activeFolderId', null);
                    await _store.save();
                } else if (savedActiveFolderId !== undefined) {
                    setActiveFolderId(savedActiveFolderId);
                }

                try {
                    const { connected } = await nasApi.telegramConnection();
                    setIsConnected(connected);
                    if (connected) {
                        queryClient.invalidateQueries({ queryKey: ['files'] });
                    }
                } catch {
                    setIsConnected(false);
                }

            } catch {
                // store not available
            }
        };
        initStore();
    }, [queryClient, onLogoutParent, currentUser?.role]);


    useEffect(() => {
        let cancelled = false;

        const refreshTelegramConnection = async () => {
            if (!networkIsOnline) {
                setIsConnected(false);
                return;
            }

            try {
                const { connected } = await nasApi.telegramConnection();
                if (!cancelled) setIsConnected(connected);
            } catch {
                if (!cancelled) setIsConnected(false);
            }
        };

        refreshTelegramConnection();

        return () => {
            cancelled = true;
        };
    }, [networkIsOnline]);


    const isNetworkError = (error: string): boolean => {
        const keywords = ['timeout', 'connection', 'network', 'socket', 'disconnected', 'EOF', 'ECONNREFUSED', 'overflow'];
        return keywords.some(k => error.toLowerCase().includes(k.toLowerCase()));
    };

    const actor = currentUser ? {
        userId: currentUser.id,
        displayName: currentUser.display_name,
        email: currentUser.email || currentUser.username,
        role: currentUser.role,
    } : null;

    const forceLogout = async () => {
        setIsConnected(false);
        try {
            await invoke('cmd_clean_cache').catch(() => { });
            if (store) {
                await store.delete('api_id');
                await store.delete('api_hash');
                await store.delete('folders');
                await store.save();
            }
        } catch {
            // best effort cleanup
        }
        toast.error("Connection lost. Please log in again.");
        onLogoutParent();
    };


    const handleLogout = async () => {
        if (!await confirm({ title: "Sign Out", message: "Are you sure you want to sign out? This will disconnect your active session.", confirmText: "Sign Out", variant: 'danger' })) return;

        try {
            await invoke('cmd_logout');
            await invoke('cmd_clean_cache');
            if (store) {
                await store.delete('api_id');
                await store.delete('api_hash');
                await store.delete('folders');
                await store.save();
            }
            onLogoutParent();
        } catch {
            toast.error("Error signing out");
            onLogoutParent();
        }
    };

    const handleSyncFolders = async () => {
        if (!store) return;
        setIsSyncing(true);
        try {
            const foundFolders = await nasApi.scanTelegramFolders();
            const merged = [...folders];
            let added = 0;
            for (const f of foundFolders) {
                if (!merged.find(existing => existing.id === f.id)) {
                    merged.push(f);
                    added++;
                }
            }
            if (added > 0) {
                setFolders(merged);
                await store.set('folders', merged);
                await store.save();
                toast.success(`Scan complete. Found ${added} new folders.`);
            } else {
                toast.info("Scan complete. No new folders found.");
            }
        } catch {
            toast.error("Sync failed");
        } finally {
            setIsSyncing(false);
        }
    };

    const handleCreateFolder = async (name: string) => {
        if (!store) return;
        try {
            const newFolder = await invoke<TelegramFolder>('cmd_create_folder', { name, accessToken: nasSession.getAccessToken(), actor });
            const updated = [...folders, newFolder];
            setFolders(updated);
            await store.set('folders', updated);
            await store.set('activeFolderId', newFolder.id);
            await store.save();
            setActiveFolderId(newFolder.id);
            toast.success(`Folder "${name}" created.`);
        } catch (e) {
            toast.error("Failed to create folder: " + e);
            throw e;
        }
    };

    const handleFolderDelete = async (folderId: number, folderName: string) => {
        if (!await confirm({
            title: "Delete Folder",
            message: `Are you sure you want to delete "${folderName}"?\nThis will delete the channel on Telegram.`,
            confirmText: "Delete",
            variant: 'danger'
        })) return;

        try {
            await invoke('cmd_delete_folder', { folderId, accessToken: nasSession.getAccessToken(), actor });
            const updated = folders.filter(f => f.id !== folderId);
            setFolders(updated);
            if (store) {
                await store.set('folders', updated);
                await store.save();
            }
            if (activeFolderId === folderId) setActiveFolderId(null);
            toast.success(`Folder "${folderName}" deleted.`);
        } catch (e: unknown) {
            const errStr = String(e);
            if (errStr.includes("not found")) {
                if (await confirm({
                    title: "Folder Not Found",
                    message: `Folder "${folderName}" not found on Telegram (it may have been deleted externally).\nRemove from this app?`,
                    confirmText: "Remove",
                    variant: 'info'
                })) {
                    const updated = folders.filter(f => f.id !== folderId);
                    setFolders(updated);
                    if (store) {
                        await store.set('folders', updated);
                        await store.save();
                    }
                    if (activeFolderId === folderId) setActiveFolderId(null);
                }
            } else {
                toast.error(`Failed to delete folder: ${e}`);
            }
        }
    };


    const handleSetActiveFolderId = async (id: number | null) => {
        setActiveFolderId(id);
        if (store) {
            await store.set('activeFolderId', id);
            await store.save();
        }
    };

    const updateFolderInStore = async (folder: TelegramFolder) => {
        const updated = folders.map((item) => item.id === folder.id ? { ...item, ...folder } : item);
        setFolders(updated);
        if (store) {
            await store.set('folders', updated);
            await store.save();
        }
    };

    const handleFolderRename = async (folderId: number, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) {
            toast.error("Folder name is required.");
            return;
        }
        try {
            const folder = await invoke<TelegramFolder>('cmd_rename_folder', {
                folderId,
                name: trimmed,
                accessToken: nasSession.getAccessToken(),
                actor
            });
            await updateFolderInStore(folder);
            toast.success("Folder renamed.");
        } catch (e) {
            toast.error(String(e));
        }
    };

    const handleFolderIconChange = async (folderId: number, icon: string | null) => {
        try {
            const folder = await invoke<TelegramFolder>('cmd_set_folder_icon', {
                folderId,
                icon: icon?.trim() || null,
                accessToken: nasSession.getAccessToken(),
                actor
            });
            await updateFolderInStore(folder);
            toast.success("Folder icon updated.");
        } catch (e) {
            toast.error(String(e));
        }
    };

    const handleFolderPassword = async (folderId: number, password: string | null) => {
        try {
            await invoke('cmd_set_folder_password', {
                folderId,
                payload: password?.trim()
                    ? { password: password.trim() }
                    : { removePassword: true },
                accessToken: nasSession.getAccessToken(),
                actor
            });
            const current = folders.find((folder) => folder.id === folderId);
            if (current) {
                await updateFolderInStore({
                    ...current,
                    is_password_protected: Boolean(password?.trim())
                });
            }
            toast.success(password?.trim() ? "Folder password set." : "Folder password removed.");
        } catch (e) {
            toast.error(String(e));
        }
    };

    return {
        store,
        folders,
        activeFolderId,
        setActiveFolderId: handleSetActiveFolderId,
        isSyncing,
        isConnected,
        handleLogout,
        handleSyncFolders,
        handleCreateFolder,
        handleFolderDelete,
        handleFolderRename,
        handleFolderIconChange,
        handleFolderPassword,
        isNetworkError,
        forceLogout
    };
}
