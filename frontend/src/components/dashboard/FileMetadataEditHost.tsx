import { FormEvent, useEffect, useState } from 'react';
import { CalendarDays, FilePenLine, RotateCcw, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';

export const FILE_METADATA_EDIT_EVENT = 'telegram-drive:edit-file-metadata';

export function openFileMetadataEditor(file: TelegramFile) {
    window.dispatchEvent(new CustomEvent(FILE_METADATA_EDIT_EVENT, { detail: { file } }));
}

export function FileMetadataEditHost() {
    const queryClient = useQueryClient();
    const [file, setFile] = useState<TelegramFile | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [displayDate, setDisplayDate] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const detail = (event as CustomEvent<{ file?: TelegramFile }>).detail;
            if (!detail?.file || detail.file.type === 'folder') return;
            setFile(detail.file);
        };

        window.addEventListener(FILE_METADATA_EDIT_EVENT, handleOpen);
        return () => window.removeEventListener(FILE_METADATA_EDIT_EVENT, handleOpen);
    }, []);

    useEffect(() => {
        if (!file) {
            setDisplayName('');
            setDisplayDate('');
            return;
        }

        let active = true;
        const folderId = file.folder_id ?? null;
        setLoading(true);
        nasApi.getFileMetadata(folderId, file.id)
            .then((metadata) => {
                if (!active) return;
                setDisplayName(metadata?.display_name || '');
                setDisplayDate(normalizeDateInput(metadata?.display_date || ''));
            })
            .catch((error) => {
                if (!active) return;
                setDisplayName('');
                setDisplayDate('');
                toast.error((error as Error).message || 'Could not load file details');
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => {
            active = false;
        };
    }, [file]);

    useEffect(() => {
        if (!file) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving) setFile(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [file, saving]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (!file || saving) return;

        setSaving(true);
        try {
            await nasApi.updateFileMetadata(file.folder_id ?? null, file.id, {
                display_name: displayName,
                display_date: displayDate,
            });
            await queryClient.invalidateQueries({ queryKey: ['files'] });
            toast.success(displayName.trim() || displayDate.trim() ? 'File details updated' : 'Original Telegram details restored');
            setFile(null);
        } catch (error) {
            toast.error((error as Error).message || 'Could not update file details');
        } finally {
            setSaving(false);
        }
    };

    if (!file) return null;

    return (
        <div
            className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !saving) setFile(null);
            }}
        >
            <form
                onSubmit={save}
                className="w-full max-w-lg overflow-hidden rounded-3xl border border-telegram-border bg-telegram-surface shadow-2xl"
            >
                <div className="flex items-start justify-between gap-4 border-b border-telegram-border px-6 py-5">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="rounded-2xl bg-telegram-primary/15 p-2.5 text-telegram-primary">
                            <FilePenLine className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg font-semibold text-telegram-text">Edit file details</h2>
                            <p className="mt-1 truncate text-xs text-telegram-subtext" title={file.name}>{file.name}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setFile(null)}
                        disabled={saving}
                        className="rounded-xl p-2 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text disabled:opacity-50"
                        aria-label="Close file details"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="space-y-5 px-6 py-5">
                    <div className="rounded-2xl border border-telegram-border bg-telegram-bg/45 p-4 text-xs leading-5 text-telegram-subtext">
                        These are NAS display overrides only. The original Telegram message, uploaded file, and Telegram timestamp stay untouched. Clear a field to use Telegram's original value again.
                    </div>

                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-telegram-text">Display name</span>
                        <input
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            disabled={loading || saving}
                            maxLength={240}
                            placeholder={file.name}
                            className="w-full rounded-2xl border border-telegram-border bg-telegram-bg/70 px-4 py-3 text-sm text-telegram-text outline-none transition placeholder:text-telegram-subtext/60 focus:border-telegram-primary disabled:opacity-60"
                        />
                        <span className="mt-2 block text-xs text-telegram-subtext">Blank = original Telegram filename.</span>
                    </label>

                    <label className="block">
                        <span className="mb-2 flex items-center gap-2 text-sm font-medium text-telegram-text">
                            <CalendarDays className="h-4 w-4 text-telegram-primary" /> Display date
                        </span>
                        <input
                            type="date"
                            value={displayDate}
                            onChange={(event) => setDisplayDate(event.target.value)}
                            disabled={loading || saving}
                            className="w-full rounded-2xl border border-telegram-border bg-telegram-bg/70 px-4 py-3 text-sm text-telegram-text outline-none transition focus:border-telegram-primary disabled:opacity-60"
                        />
                        <span className="mt-2 block text-xs text-telegram-subtext">Current value shown by Telegram Drive: {file.created_at || 'Unknown'}.</span>
                    </label>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-telegram-border px-6 py-4">
                    <button
                        type="button"
                        onClick={() => {
                            setDisplayName('');
                            setDisplayDate('');
                        }}
                        disabled={loading || saving}
                        className="inline-flex items-center gap-2 rounded-2xl border border-telegram-border px-4 py-2.5 text-sm text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text disabled:opacity-50"
                    >
                        <RotateCcw className="h-4 w-4" /> Reset fields
                    </button>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => setFile(null)}
                            disabled={saving}
                            className="rounded-2xl border border-telegram-border px-4 py-2.5 text-sm text-telegram-text transition hover:bg-telegram-hover disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading || saving}
                            className="rounded-2xl bg-telegram-primary px-5 py-2.5 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {saving ? 'Saving…' : 'Save details'}
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
}

function normalizeDateInput(value: string) {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || '';
}
