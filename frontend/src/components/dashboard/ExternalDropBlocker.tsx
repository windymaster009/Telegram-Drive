import { useState, useEffect } from 'react';
import { Upload } from 'lucide-react';

const EXTERNAL_FILE_DROP_EVENT = 'telegram-drive:external-file-drop';
const isTauriRuntime = () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Handles files dragged in from the operating system. Internal Telegram Drive
 * drags use a custom data-transfer type, so they are left alone.
 *
 * Browser/web builds can upload File objects directly. The Tauri desktop build
 * keeps its file-picker fallback because native uploads require filesystem paths.
 */
export function ExternalDropBlocker({ onUploadClick }: { onUploadClick: () => void }) {
    const [showMessage, setShowMessage] = useState(false);
    const desktopRuntime = isTauriRuntime();

    useEffect(() => {
        let hideTimeout: ReturnType<typeof setTimeout>;

        const handleDragOver = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = desktopRuntime ? 'none' : 'copy';
                setShowMessage(true);
                clearTimeout(hideTimeout);
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            if (e.clientX <= 0 || e.clientY <= 0 ||
                e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
                hideTimeout = setTimeout(() => setShowMessage(false), 100);
            }
        };

        const handleDrop = (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes('Files')) return;

            e.preventDefault();
            e.stopPropagation();

            if (desktopRuntime) {
                hideTimeout = setTimeout(() => setShowMessage(false), 2000);
                return;
            }

            const files = Array.from(e.dataTransfer.files ?? []);
            setShowMessage(false);

            if (files.length > 0) {
                window.dispatchEvent(new CustomEvent<File[]>(EXTERNAL_FILE_DROP_EVENT, {
                    detail: files,
                }));
            }
        };

        document.addEventListener('dragover', handleDragOver, true);
        document.addEventListener('dragleave', handleDragLeave, true);
        document.addEventListener('drop', handleDrop, true);

        return () => {
            document.removeEventListener('dragover', handleDragOver, true);
            document.removeEventListener('dragleave', handleDragLeave, true);
            document.removeEventListener('drop', handleDrop, true);
            clearTimeout(hideTimeout);
        };
    }, [desktopRuntime]);

    if (!showMessage) return null;

    return (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="glass bg-telegram-surface border border-telegram-border rounded-2xl p-8 max-w-md mx-4 shadow-2xl pointer-events-auto">
                <div className="flex flex-col items-center text-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-telegram-primary/20 flex items-center justify-center">
                        <Upload className="w-8 h-8 text-telegram-primary" />
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-telegram-text mb-2">
                            {desktopRuntime ? 'Use the Upload Button' : 'Drop files to upload'}
                        </h3>
                        <p className="text-telegram-subtext text-sm">
                            {desktopRuntime
                                ? 'Desktop uploads still use the native file picker.'
                                : 'Release anywhere to upload these files to the current folder.'}
                            <br />
                            <span className="text-xs opacity-70 mt-2 block">
                                {desktopRuntime
                                    ? 'Drag-and-drop from the operating system is not available in desktop mode.'
                                    : 'You can drop multiple files at once.'}
                            </span>
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            setShowMessage(false);
                            onUploadClick();
                        }}
                        className="mt-2 px-6 py-2 bg-telegram-primary text-white rounded-lg font-medium hover:bg-telegram-primary/90 transition-colors"
                    >
                        {desktopRuntime ? 'Open Upload Dialog' : 'Choose Files Instead'}
                    </button>
                </div>
            </div>
        </div>
    );
}
