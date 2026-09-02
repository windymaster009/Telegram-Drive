import { FormEvent, useEffect, useState } from 'react';
import { KeyRound, Pencil, UserRound, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { AppUser } from '@shared/nas';
import { nasApi } from '../../lib/nasApi';

export const ADMIN_USER_EDIT_EVENT = 'telegram-drive:edit-admin-user';
export const ADMIN_USER_UPDATED_EVENT = 'telegram-drive:admin-user-updated';

export function openAdminUserEditor(user: AppUser) {
    window.dispatchEvent(new CustomEvent(ADMIN_USER_EDIT_EVENT, { detail: { user } }));
}

export function AdminUserEditHost({ csrfToken }: { csrfToken: string | null }) {
    const queryClient = useQueryClient();
    const [user, setUser] = useState<AppUser | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [telegramUsername, setTelegramUsername] = useState('');
    const [role, setRole] = useState<'admin' | 'user'>('user');
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const nextUser = (event as CustomEvent<{ user?: AppUser }>).detail?.user;
            if (!nextUser) return;
            setUser(nextUser);
            setDisplayName(nextUser.display_name || '');
            setTelegramUsername(nextUser.telegram_username || '');
            setRole(nextUser.role);
            setPassword('');
        };

        window.addEventListener(ADMIN_USER_EDIT_EVENT, handleOpen);
        return () => window.removeEventListener(ADMIN_USER_EDIT_EVENT, handleOpen);
    }, []);

    useEffect(() => {
        if (!user) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving) setUser(null);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [user, saving]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (!user || !csrfToken || saving) return;

        const normalizedDisplayName = displayName.trim();
        if (!normalizedDisplayName) {
            toast.error('Display name is required');
            return;
        }
        if (password && password.length < 8) {
            toast.error('New password must be at least 8 characters');
            return;
        }

        const payload: Record<string, unknown> = {
            display_name: normalizedDisplayName,
            role,
        };
        const normalizedTelegramUsername = telegramUsername.trim();
        if (normalizedTelegramUsername) payload.telegram_username = normalizedTelegramUsername;
        if (password) payload.password = password;

        setSaving(true);
        try {
            await nasApi.updateUser(user.id, payload, csrfToken);
            const updatedUser: AppUser = {
                ...user,
                display_name: normalizedDisplayName,
                telegram_username: normalizedTelegramUsername || user.telegram_username,
                role,
            };
            await queryClient.invalidateQueries({ queryKey: ['admin-users'] });
            window.dispatchEvent(new CustomEvent(ADMIN_USER_UPDATED_EVENT, { detail: { user: updatedUser } }));
            toast.success('User details updated');
            setUser(null);
        } catch (error) {
            toast.error((error as Error).message || 'Could not update user');
        } finally {
            setSaving(false);
        }
    };

    if (!user) return null;

    return (
        <div
            className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !saving) setUser(null);
            }}
        >
            <form onSubmit={save} className="w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-slate-950 shadow-2xl">
                <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="rounded-2xl bg-cyan-400/10 p-2.5 text-cyan-300">
                            <Pencil className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-xs uppercase tracking-[0.24em] text-cyan-300">Edit user</p>
                            <h2 className="mt-1 truncate text-xl font-semibold text-white">{user.display_name}</h2>
                            <p className="mt-1 text-xs text-slate-400">@{user.username}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setUser(null)}
                        disabled={saving}
                        className="rounded-xl border border-white/10 p-2 text-slate-300 transition hover:bg-white/8 hover:text-white disabled:opacity-50"
                        aria-label="Close edit user"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
                    <label className="sm:col-span-2">
                        <span className="mb-2 flex items-center gap-2 text-sm text-slate-300"><UserRound className="h-4 w-4" /> Display name</span>
                        <input
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            disabled={saving}
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/60 disabled:opacity-60"
                        />
                    </label>

                    <label>
                        <span className="mb-2 block text-sm text-slate-300">Telegram username</span>
                        <input
                            value={telegramUsername}
                            onChange={(event) => setTelegramUsername(event.target.value)}
                            disabled={saving}
                            placeholder="@username"
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/60 disabled:opacity-60"
                        />
                        <span className="mt-2 block text-xs text-slate-500">If an existing Telegram username is cleared, it is left unchanged.</span>
                    </label>

                    <label>
                        <span className="mb-2 block text-sm text-slate-300">Role</span>
                        <select
                            value={role}
                            onChange={(event) => setRole(event.target.value as 'admin' | 'user')}
                            disabled={saving}
                            className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-300/60 disabled:opacity-60"
                        >
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                        </select>
                    </label>

                    <label className="sm:col-span-2">
                        <span className="mb-2 flex items-center gap-2 text-sm text-slate-300"><KeyRound className="h-4 w-4" /> New password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            disabled={saving}
                            autoComplete="new-password"
                            placeholder="Leave blank to keep current password"
                            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/60 disabled:opacity-60"
                        />
                    </label>
                </div>

                <div className="flex justify-end gap-2 border-t border-white/10 px-6 py-4">
                    <button
                        type="button"
                        onClick={() => setUser(null)}
                        disabled={saving}
                        className="rounded-2xl border border-white/10 px-4 py-2.5 text-sm text-slate-200 transition hover:bg-white/8 disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving || !csrfToken}
                        className="rounded-2xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {saving ? 'Saving…' : 'Save user'}
                    </button>
                </div>
            </form>
        </div>
    );
}
