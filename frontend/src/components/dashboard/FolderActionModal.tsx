import { useEffect, useMemo, useState } from 'react';
import { Check, KeyRound, Palette, Pencil, X } from 'lucide-react';
import type { TelegramFolder } from '@shared/telegram';

type FolderAction = 'rename' | 'icon' | 'password';

interface FolderActionModalProps {
    action: FolderAction;
    folder: TelegramFolder;
    onClose: () => void;
    onRename: (name: string) => Promise<void>;
    onChangeIcon: (icon: string | null) => Promise<void>;
    onSetPassword: (password: string | null) => Promise<void>;
}

const FOLDER_EMOJIS = [
    '📁', '📂', '🗂️', '🗃️', '🗄️', '💾', '💿', '📀', '🧰', '🧳',
    '⭐', '🔥', '💎', '🔐', '🔑', '🛡️', '⚙️', '📦', '📌', '🏷️',
    '🎬', '🎵', '🎧', '🎮', '📷', '🎨', '📚', '📝', '💼', '🏠',
    '☁️', '🚀', '🌙', '☀️', '🌈', '🍀', '🎯', '🧠', '💡', '❤️',
    '🧾', '📊', '📈', '🧮', '🧪', '🛠️', '🧵', '🖼️', '🗓️', '🧭',
    '🇰🇭', '🇺🇸', '🇯🇵', '🇰🇷', '🇸🇬', '🇫🇷', '🇩🇪', '🇬🇧',
];

export function FolderActionModal({
    action,
    folder,
    onClose,
    onRename,
    onChangeIcon,
    onSetPassword,
}: FolderActionModalProps) {
    const [name, setName] = useState(folder.name);
    const [selectedIcon, setSelectedIcon] = useState(folder.icon || '📁');
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setName(folder.name);
        setSelectedIcon(folder.icon || '📁');
        setPassword('');
    }, [folder, action]);

    const title = useMemo(() => {
        if (action === 'rename') return 'Rename folder';
        if (action === 'password') return 'Folder password';
        return 'Change folder icon';
    }, [action]);

    const Icon = action === 'rename' ? Pencil : action === 'password' ? KeyRound : Palette;

    const save = async () => {
        setSaving(true);
        try {
            if (action === 'rename') await onRename(name);
            if (action === 'icon') await onChangeIcon(selectedIcon);
            if (action === 'password') await onSetPassword(password);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    const removePassword = async () => {
        setSaving(true);
        try {
            await onSetPassword(null);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-lg rounded-2xl border border-telegram-border bg-telegram-surface p-5 shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="rounded-xl border border-telegram-border bg-white/5 p-2 text-telegram-primary">
                            <Icon className="h-5 w-5" />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-telegram-text">{title}</h2>
                            <p className="text-sm text-telegram-subtext">{folder.name}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="rounded-lg p-2 text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {action === 'rename' && (
                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-telegram-text">Folder name</span>
                        <input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => event.key === 'Enter' && save()}
                            className="w-full rounded-xl border border-telegram-border bg-telegram-bg px-4 py-3 text-sm text-telegram-text outline-none transition focus:border-telegram-primary"
                        />
                    </label>
                )}

                {action === 'password' && (
                    <div className="space-y-4">
                        <label className="block">
                            <span className="mb-2 block text-sm font-medium text-telegram-text">New password</span>
                            <input
                                autoFocus
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                onKeyDown={(event) => event.key === 'Enter' && password.trim() && save()}
                                className="w-full rounded-xl border border-telegram-border bg-telegram-bg px-4 py-3 text-sm text-telegram-text outline-none transition focus:border-telegram-primary"
                            />
                        </label>
                        {folder.is_password_protected && (
                            <button
                                onClick={removePassword}
                                disabled={saving}
                                className="w-full rounded-xl border border-red-500/30 px-4 py-3 text-sm font-medium text-red-400 transition hover:bg-red-500/10 disabled:opacity-60"
                            >
                                Remove folder password
                            </button>
                        )}
                    </div>
                )}

                {action === 'icon' && (
                    <div className="space-y-4">
                        <div className="rounded-xl border border-telegram-border bg-telegram-bg p-3">
                            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-telegram-subtext">Current selected emoji</p>
                            <div className="flex items-center gap-3">
                                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-telegram-primary bg-telegram-primary/10 text-2xl">
                                    {selectedIcon}
                                </div>
                                <button
                                    onClick={() => setSelectedIcon('')}
                                    className="rounded-lg border border-telegram-border px-3 py-2 text-sm text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                                >
                                    Use default
                                </button>
                            </div>
                        </div>
                        <div className="grid max-h-72 grid-cols-8 gap-2 overflow-y-auto pr-1">
                            {FOLDER_EMOJIS.map((emoji) => (
                                <button
                                    key={emoji}
                                    onClick={() => setSelectedIcon(emoji)}
                                    className={`flex aspect-square items-center justify-center rounded-xl border text-xl transition ${selectedIcon === emoji
                                        ? 'border-telegram-primary bg-telegram-primary/15 ring-1 ring-telegram-primary'
                                        : 'border-telegram-border bg-telegram-bg hover:bg-telegram-hover'
                                        }`}
                                >
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="rounded-xl border border-telegram-border px-4 py-2 text-sm font-medium text-telegram-subtext transition hover:bg-telegram-hover hover:text-telegram-text"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={save}
                        disabled={saving || (action === 'rename' && !name.trim()) || (action === 'password' && !password.trim())}
                        className="inline-flex items-center gap-2 rounded-xl bg-telegram-primary px-4 py-2 text-sm font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <Check className="h-4 w-4" />
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
