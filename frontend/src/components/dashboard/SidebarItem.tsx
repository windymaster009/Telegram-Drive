import { useEffect, useRef, useState } from 'react';
import { KeyRound, LockKeyhole, Palette, Pencil, Trash2 } from 'lucide-react';

interface SidebarItemProps {
    icon: React.ElementType;
    folderIcon?: string | null;
    label: string;
    ownerName?: string;
    active: boolean;
    onClick: () => void;
    onDrop: (e: React.DragEvent) => void;
    canManage?: boolean;
    isPasswordProtected?: boolean;
    onChangeIcon?: () => void;
    onRename?: () => void;
    onSetPassword?: () => void;
    onDelete?: () => void;
    folderId: number | null;
}

/**
 * SidebarItem - Pure DOM event-based drop handling
 * 
 * With Tauri's dragDropEnabled: false, DOM events work reliably.
 * This component handles internal file moves via standard React drag events.
 */
export function SidebarItem({
    icon: Icon,
    folderIcon,
    label,
    ownerName,
    active = false,
    onClick,
    onDrop,
    canManage = false,
    isPasswordProtected = false,
    onChangeIcon,
    onRename,
    onSetPassword,
    onDelete
}: SidebarItemProps) {
    const [isOver, setIsOver] = useState(false);
    const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuPos) return;
        const close = () => setMenuPos(null);
        window.addEventListener('click', close);
        window.addEventListener('resize', close);
        window.addEventListener('contextmenu', close);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('resize', close);
            window.removeEventListener('contextmenu', close);
        };
    }, [menuPos]);

    const runAction = (action?: () => void) => {
        setMenuPos(null);
        action?.();
    };

    return (
        <>
            <button
                onClick={onClick}
                onDragEnter={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOver(true);
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                }}
                onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX;
                    const y = e.clientY;
                    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                        setIsOver(false);
                    }
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOver(false);
                    if (onDrop) onDrop(e);
                }}
                onContextMenu={(e) => {
                    if (onDelete || onRename || onChangeIcon || onSetPassword) {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuPos({ x: e.clientX, y: e.clientY });
                    }
                }}
                title={ownerName ? `Created by: ${ownerName}` : undefined}
                className={`group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${active
                    ? 'bg-telegram-primary/10 text-telegram-primary'
                    : isOver
                        ? 'bg-telegram-primary/30 text-telegram-text ring-2 ring-telegram-primary scale-[1.02] shadow-lg'
                        : 'text-telegram-subtext hover:bg-telegram-hover hover:text-telegram-text'
                    }`}
            >
                {folderIcon ? (
                    <span className="w-4 h-4 shrink-0 text-center text-sm leading-4">{folderIcon}</span>
                ) : (
                    <Icon className={`w-4 h-4 ${isOver ? 'text-telegram-primary' : ''}`} />
                )}
                <span className="flex-1 text-left truncate">{label}</span>
                {isPasswordProtected && (
                    <LockKeyhole className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-telegram-primary' : 'text-telegram-subtext'}`} />
                )}
            </button>
            {menuPos && (
                <div
                    ref={menuRef}
                    className="fixed z-50 min-w-[220px] rounded-lg border border-telegram-border bg-telegram-surface/95 p-1.5 text-telegram-text shadow-2xl backdrop-blur-xl"
                    style={{ left: menuPos.x, top: menuPos.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div className="border-b border-telegram-border px-2 py-1.5 text-left text-xs font-medium text-telegram-subtext">
                        <div className="truncate">{label}</div>
                        {ownerName && <div className="mt-0.5 truncate">Created by: {ownerName}</div>}
                    </div>
                    {canManage && onChangeIcon && (
                        <MenuButton icon={Palette} label="Change folder icon" onClick={() => runAction(onChangeIcon)} />
                    )}
                    {canManage && onRename && (
                        <MenuButton icon={Pencil} label="Rename" onClick={() => runAction(onRename)} />
                    )}
                    {canManage && onSetPassword && (
                        <MenuButton icon={KeyRound} label="Set password to folder" onClick={() => runAction(onSetPassword)} />
                    )}
                    {canManage && onDelete && (
                        <>
                            <div className="my-1 h-px bg-telegram-border" />
                            <MenuButton icon={Trash2} label="Delete" danger onClick={() => runAction(onDelete)} />
                        </>
                    )}
                </div>
            )}
        </>
    )
}

function MenuButton({
    icon: Icon,
    label,
    danger,
    onClick,
}: {
    icon: React.ElementType;
    label: string;
    danger?: boolean;
    onClick: () => void;
}) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onClick();
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-telegram-text hover:bg-telegram-hover'
                }`}
        >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
        </div>
    );
}
