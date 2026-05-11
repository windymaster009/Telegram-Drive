import { invoke } from '@tauri-apps/api/core';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '../context/ConfirmContext';
import type { TelegramFile } from '@shared/telegram';
import { getApiBaseUrl, nasApi, nasSession } from '../lib/nasApi';

const TEXT_MESSAGES_FILE_ID = -1;

export function useFileOperations(
    activeFolderId: number | null,
    selectedIds: number[],
    setSelectedIds: (ids: number[]) => void,
    displayedFiles: TelegramFile[]
) {
    const queryClient = useQueryClient();
    const { confirm } = useConfirm();
    const isTextMessagesFile = (id: number) => id === TEXT_MESSAGES_FILE_ID;

    const handleDelete = async (id: number) => {
        if (isTextMessagesFile(id)) {
            toast.info("Text messages are grouped for display and cannot be deleted as a single file.");
            return;
        }
        if (!await confirm({ title: "Delete File", message: "Are you sure you want to delete this file?", confirmText: "Delete", variant: 'danger' })) return;
        try {
            await nasApi.deleteTelegramFile(id, activeFolderId);
            queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
            toast.success("File deleted");
        } catch (e) {
            toast.error(`Delete failed: ${e}`);
        }
    }

    const handleBulkDelete = async () => {
        if (selectedIds.length === 0) return;
        const deletableIds = selectedIds.filter((id) => !isTextMessagesFile(id));
        if (deletableIds.length === 0) {
            toast.info("Text messages are grouped for display and cannot be deleted as a single file.");
            return;
        }
        if (!await confirm({ title: "Delete Files", message: `Are you sure you want to delete ${deletableIds.length} files?`, confirmText: "Delete All", variant: 'danger' })) return;

        let success = 0;
        let fail = 0;
        for (const id of deletableIds) {
            try {
                    await nasApi.deleteTelegramFile(id, activeFolderId);
                success++;
            } catch {
                fail++;
            }
        }
        setSelectedIds([]);
        queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
        if (success > 0) toast.success(`Deleted ${success} files.`);
        if (fail > 0) toast.error(`Failed to delete ${fail} files.`);
    }

    const handleDownload = async (id: number, name: string) => {
        try {
            const savePath = await import('@tauri-apps/plugin-dialog').then(d => d.save({
                defaultPath: name,
            }));
            if (!savePath) return;
            toast.info(`Download started: ${name}`);
            await invoke('cmd_download_file_from_api', {
                messageId: id,
                savePath,
                folderId: activeFolderId,
                apiBaseUrl: getApiBaseUrl(),
                accessToken: nasSession.getAccessToken(),
            });
            toast.success(`Download complete: ${name}`);
        } catch (e) {
            toast.error(`Download failed: ${e}`);
        }
    }

    const handleBulkDownload = async () => {
        if (selectedIds.length === 0) return;
        try {
            const dirPath = await import('@tauri-apps/plugin-dialog').then(d => d.open({
                directory: true, multiple: false, title: "Select Download Destination"
            }));
            if (!dirPath) return;
            let successCount = 0;
            const targetFiles = displayedFiles.filter((f) => selectedIds.includes(f.id));
            toast.info(`Starting batch download of ${targetFiles.length} files...`);

            for (const file of targetFiles) {
                const filePath = `${dirPath}/${file.name}`;
                try {
                    await invoke('cmd_download_file_from_api', {
                        messageId: file.id,
                        savePath: filePath,
                        folderId: activeFolderId,
                        apiBaseUrl: getApiBaseUrl(),
                        accessToken: nasSession.getAccessToken(),
                    });
                    successCount++;
                } catch (e) { }
            }
            toast.success(`Downloaded ${successCount} files.`);
            setSelectedIds([]);
        } catch (e) {
            toast.error(`Bulk download failed: ${e}`);
        }
    }

    const handleBulkMove = async (targetFolderId: number | null, onSuccess?: () => void) => {
        if (selectedIds.length === 0) return;
        const movableIds = selectedIds.filter((id) => !isTextMessagesFile(id));
        if (movableIds.length === 0) {
            toast.info("Text messages are grouped for display and cannot be moved as a single file.");
            return;
        }
        try {
            await nasApi.moveTelegramFiles({
                message_ids: movableIds,
                source_folder_id: activeFolderId,
                target_folder_id: targetFolderId,
            });
            toast.success(`Moved ${movableIds.length} files.`);
            queryClient.invalidateQueries({ queryKey: ['files', activeFolderId] });
            setSelectedIds([]);
            if (onSuccess) onSuccess();
        } catch {
            toast.error('Failed to move files');
        }
    };

    const handleBulkCopy = async (targetFolderId: number | null, onSuccess?: () => void) => {
        if (selectedIds.length === 0) return;
        const copyableIds = selectedIds.filter((id) => !isTextMessagesFile(id));
        if (copyableIds.length === 0) {
            toast.info("Text messages are grouped for display and cannot be copied as a single file.");
            return;
        }
        try {
            await nasApi.copyTelegramFiles({
                message_ids: copyableIds,
                source_folder_id: activeFolderId,
                target_folder_id: targetFolderId,
            });
            toast.success(`Copied ${copyableIds.length} files.`);
            queryClient.invalidateQueries({ queryKey: ['files', targetFolderId] });
            setSelectedIds([]);
            if (onSuccess) onSuccess();
        } catch {
            toast.error('Failed to copy files');
        }
    };

    const handleDownloadFolder = async () => {
        if (displayedFiles.length === 0) {
            toast.info("Folder is empty.");
            return;
        }
        try {
            const dirPath = await import('@tauri-apps/plugin-dialog').then(d => d.open({
                directory: true, multiple: false, title: "Download Folder To..."
            }));
            if (!dirPath) return;
            let successCount = 0;
            toast.info(`Downloading folder contents (${displayedFiles.length} files)...`);
            for (const file of displayedFiles) {
                const filePath = `${dirPath}/${file.name}`;
                try {
                    await invoke('cmd_download_file_from_api', {
                        messageId: file.id,
                        savePath: filePath,
                        folderId: activeFolderId,
                        apiBaseUrl: getApiBaseUrl(),
                        accessToken: nasSession.getAccessToken(),
                    });
                    successCount++;
                } catch (e) { }
            }
            toast.success(`Folder Download Complete: ${successCount} files.`);
        } catch (e) {
            toast.error("Error: " + e);
        }
    }

    return {
        handleDelete,
        handleBulkDelete,
        handleDownload,
        handleBulkDownload,
        handleBulkMove,
        handleBulkCopy,
        handleDownloadFolder,
        handleGlobalSearch: async (query: string) => {
            try {
                return await nasApi.searchTelegramFiles(query);
            } catch {
                return [];
            }
        }
    };
}
