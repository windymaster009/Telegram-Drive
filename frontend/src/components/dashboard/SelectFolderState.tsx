import { FolderOpen } from 'lucide-react';

export function SelectFolderState() {
    return (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <div className="mb-5 rounded-2xl border border-telegram-border bg-telegram-surface p-5 text-telegram-primary">
                <FolderOpen className="h-10 w-10" />
            </div>
            <h2 className="text-xl font-semibold text-telegram-text">Select a folder to continue</h2>
            <p className="mt-2 max-w-sm text-sm text-telegram-subtext">
                Select any folder you want to use from the sidebar.
            </p>
        </div>
    );
}
