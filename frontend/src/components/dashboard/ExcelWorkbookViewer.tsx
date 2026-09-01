import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';

const LazyXlsxViewer = lazy(async () => {
    const module = await import('@extend-ai/react-xlsx');
    return { default: module.XlsxViewer };
});

interface ExcelWorkbookViewerProps {
    file: TelegramFile;
    activeFolderId: number | null;
}

const MAX_EXCEL_PREVIEW_BYTES = 50 * 1024 * 1024;
const READ_ONLY_ABOVE_BYTES = 10 * 1024 * 1024;

function LoadingState({ label = 'Loading workbook...' }: { label?: string }) {
    return (
        <div className="flex h-[72vh] w-[min(1400px,92vw)] flex-col items-center justify-center gap-3 rounded-lg bg-[#202124] text-white/70 shadow-2xl">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-telegram-primary border-t-transparent" />
            <span className="text-sm">{label}</span>
        </div>
    );
}

export function ExcelWorkbookViewer({ file, activeFolderId }: ExcelWorkbookViewerProps) {
    const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const streamUrl = useMemo(
        () => nasApi.streamUrl(activeFolderId, file.id),
        [activeFolderId, file.id]
    );

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        setBuffer(null);
        setError(null);

        async function loadWorkbook() {
            try {
                if (file.size > MAX_EXCEL_PREVIEW_BYTES) {
                    throw new Error('This workbook is larger than 50 MB. Download it instead of previewing it in the browser.');
                }

                const response = await fetch(streamUrl, { signal: controller.signal });
                if (!response.ok) {
                    throw new Error(`Workbook request failed (HTTP ${response.status})`);
                }

                const data = await response.arrayBuffer();
                if (!cancelled) setBuffer(data);
            } catch (err) {
                if (controller.signal.aborted) return;
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        }

        loadWorkbook();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [file.size, streamUrl]);

    if (error) {
        return (
            <div className="w-[min(1100px,88vw)] rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-5 text-center text-red-200">
                <div className="font-semibold">Excel Preview Error</div>
                <div className="mt-1 text-sm text-red-200/80">{error}</div>
            </div>
        );
    }

    if (!buffer) {
        return <LoadingState label="Loading workbook from Telegram..." />;
    }

    return (
        <div className="h-[76vh] w-[min(1500px,94vw)] overflow-hidden rounded-lg border border-white/10 bg-white shadow-2xl">
            <Suspense fallback={<LoadingState label="Starting Excel viewer..." />}>
                <LazyXlsxViewer
                    file={buffer}
                    fileName={file.name}
                    height="76vh"
                    readOnly
                    readOnlyAboveBytes={READ_ONLY_ABOVE_BYTES}
                    maxFileSizeBytes={MAX_EXCEL_PREVIEW_BYTES}
                    showDefaultToolbar
                    showImages
                    useWorker
                    isDark={false}
                    rounded={false}
                />
            </Suspense>
        </div>
    );
}
