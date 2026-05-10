import { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import type { TelegramFolder } from '@shared/telegram';

interface FolderUnlockModalProps {
    folder: TelegramFolder;
    error?: string | null;
    onClose: () => void;
    onUnlock: (password: string) => Promise<void>;
}

export function FolderUnlockModal({ folder, error, onClose, onUnlock }: FolderUnlockModalProps) {
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!password.trim()) return;
        setSaving(true);
        try {
            await onUnlock(password);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-md rounded-2xl border border-telegram-border bg-telegram-surface p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="rounded-xl border border-telegram-border bg-white/5 p-2 text-telegram-primary">
                            <KeyRound className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-telegram-text">Unlock folder</h2>
                            <p className="text-sm text-telegram-subtext">{folder.name}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-2 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <label className="block">
                    <span className="mb-2 block text-sm font-medium text-telegram-text">Folder password</span>
                    <input
                        autoFocus
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && submit()}
                        className="w-full rounded-xl border border-telegram-border bg-telegram-bg px-4 py-3 text-sm text-telegram-text outline-none transition focus:border-telegram-primary"
                    />
                </label>
                {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

                <div className="mt-5 flex justify-end gap-2">
                    <button onClick={onClose} className="rounded-xl border border-telegram-border px-4 py-2 text-sm font-medium text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text">
                        Cancel
                    </button>
                    <button
                        onClick={submit}
                        disabled={saving || !password.trim()}
                        className="rounded-xl bg-telegram-primary px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Unlock
                    </button>
                </div>
            </div>
        </div>
    );
}
