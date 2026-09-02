import { useEffect, useMemo, useRef, useState } from 'react';
import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';

interface WordDocumentViewerProps {
    file: TelegramFile;
    activeFolderId: number | null;
}

const MAX_DOCX_PREVIEW_BYTES = 40 * 1024 * 1024;

export function WordDocumentViewer({ file, activeFolderId }: WordDocumentViewerProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const streamUrl = useMemo(
        () => nasApi.streamUrl(activeFolderId, file.id),
        [activeFolderId, file.id]
    );

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        const container = containerRef.current;

        setLoading(true);
        setError(null);
        if (container) container.innerHTML = '';

        async function renderDocument() {
            try {
                if (file.size > MAX_DOCX_PREVIEW_BYTES) {
                    throw new Error('This Word document is larger than 40 MB. Download it instead of previewing it in the browser.');
                }

                const response = await fetch(streamUrl, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`Word document request failed (HTTP ${response.status})`);
                }

                const data = await response.arrayBuffer();
                if (cancelled) return;

                const target = containerRef.current;
                if (!target) return;

                const { renderAsync } = await import('docx-preview');
                if (cancelled) return;

                await renderAsync(data, target, target, {
                    className: 'telegram-drive-docx',
                    inWrapper: true,
                    breakPages: true,
                    ignoreWidth: false,
                    ignoreHeight: false,
                    ignoreFonts: false,
                    ignoreLastRenderedPageBreak: false,
                    renderHeaders: true,
                    renderFooters: true,
                    renderFootnotes: true,
                    renderEndnotes: true,
                    renderChanges: false,
                    renderComments: false,
                    renderAltChunks: true,
                    useBase64URL: true,
                    experimental: false,
                    debug: false,
                });

                if (!cancelled) setLoading(false);
            } catch (err) {
                if (controller.signal.aborted || cancelled) return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        }

        renderDocument();

        return () => {
            cancelled = true;
            controller.abort();
            if (container) container.innerHTML = '';
        };
    }, [file.id, file.name, file.size, streamUrl]);

    if (error) {
        return (
            <div className="w-[min(1100px,90vw)] rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-5 text-center text-red-200">
                <div className="font-semibold">Word Preview Error</div>
                <div className="mt-1 text-sm text-red-200/80">{error}</div>
            </div>
        );
    }

    return (
        <div className="relative h-[80vh] w-[min(1400px,94vw)] overflow-auto rounded-lg bg-[#202124] shadow-2xl custom-scrollbar">
            <style>{`
                .telegram-drive-docx-wrapper {
                    background: #202124 !important;
                    padding: 20px 24px 32px !important;
                }
                .telegram-drive-docx-wrapper > section.telegram-drive-docx {
                    margin: 0 auto 24px !important;
                    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35) !important;
                }
                @media (max-width: 700px) {
                    .telegram-drive-docx-wrapper {
                        padding: 10px 6px 20px !important;
                    }
                }
            `}</style>

            {loading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#202124] text-white/70">
                    <div className="h-10 w-10 animate-spin rounded-full border-4 border-telegram-primary border-t-transparent" />
                    <span className="text-sm">Rendering Word document...</span>
                </div>
            )}

            <div ref={containerRef} className="min-h-full" />
        </div>
    );
}
