import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';
import { FileTypeIcon } from '../FileTypeIcon';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface FilePreviewProps {
    file: TelegramFile;
    activeFolderId?: number | null;
}

type OfficePreview =
    | { kind: 'document'; lines: string[] }
    | { kind: 'sheet'; rows: string[][] }
    | { kind: 'slide'; lines: string[] }
    | { kind: 'text'; text: string };

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']);
const TEXT_EXTENSIONS = new Set([
    'txt', 'rtf', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'log', 'ini', 'conf',
    'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'html', 'css', 'sql', 'sh', 'ps1',
]);
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const MAX_TEXT_PREVIEW_BYTES = 1_500_000;
const MAX_OFFICE_PREVIEW_BYTES = 10_000_000;

function getExtension(filename: string): string {
    const name = filename.split('/').pop() || filename;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function useNearViewport() {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const element = ref.current;
        if (!element || visible) return;

        if (!('IntersectionObserver' in window)) {
            setVisible(true);
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '500px 0px' }
        );

        observer.observe(element);
        return () => observer.disconnect();
    }, [visible]);

    return { ref, visible };
}

function LoadingPreview() {
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-telegram-bg/30">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-telegram-primary/25 border-t-telegram-primary" />
        </div>
    );
}

function IconFallback({ filename }: { filename: string }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-telegram-bg/25 p-3">
            <FileTypeIcon filename={filename} size="lg" />
        </div>
    );
}

export function FilePreview({ file, activeFolderId = null }: FilePreviewProps) {
    const { ref, visible } = useNearViewport();
    const extension = useMemo(() => getExtension(file.name), [file.name]);
    const streamUrl = useMemo(
        () => nasApi.streamUrl(activeFolderId ?? null, file.id),
        [activeFolderId, file.id]
    );

    let content: React.ReactNode = <IconFallback filename={file.name} />;

    if (visible && IMAGE_EXTENSIONS.has(extension)) {
        content = <ImageThumbnail src={streamUrl} filename={file.name} />;
    } else if (visible && extension === 'pdf') {
        content = <PdfThumbnail src={streamUrl} filename={file.name} />;
    } else if (visible && VIDEO_EXTENSIONS.has(extension)) {
        content = <VideoThumbnail src={streamUrl} filename={file.name} />;
    } else if (
        visible &&
        ((TEXT_EXTENSIONS.has(extension) && file.size <= MAX_TEXT_PREVIEW_BYTES) ||
            (OFFICE_EXTENSIONS.has(extension) && file.size <= MAX_OFFICE_PREVIEW_BYTES))
    ) {
        content = <StructuredPreview file={file} src={streamUrl} extension={extension} />;
    }

    return (
        <div ref={ref} className="absolute inset-0 overflow-hidden bg-telegram-bg/30">
            {content}
        </div>
    );
}

function ImageThumbnail({ src, filename }: { src: string; filename: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) return <IconFallback filename={filename} />;

    return (
        <img
            src={src}
            alt={filename}
            loading="lazy"
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
        />
    );
}

function VideoThumbnail({ src, filename }: { src: string; filename: string }) {
    const [failed, setFailed] = useState(false);
    const [ready, setReady] = useState(false);

    if (failed) return <IconFallback filename={filename} />;

    return (
        <>
            {!ready && <LoadingPreview />}
            <video
                src={src}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    try {
                        if (Number.isFinite(video.duration) && video.duration > 0.2) {
                            video.currentTime = Math.min(0.5, video.duration / 10);
                        } else {
                            setReady(true);
                        }
                    } catch {
                        setReady(true);
                    }
                }}
                onSeeked={() => setReady(true)}
                onLoadedData={() => setReady(true)}
                onError={() => setFailed(true)}
                className={`absolute inset-0 h-full w-full object-cover transition-opacity ${ready ? 'opacity-100' : 'opacity-0'}`}
            />
            {ready && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-sm text-white shadow-lg backdrop-blur-sm">▶</div>
                </div>
            )}
        </>
    );
}

function PdfThumbnail({ src, filename }: { src: string; filename: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [failed, setFailed] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const loadingTask = pdfjsLib.getDocument(src);
        let renderTask: ReturnType<pdfjsLib.PDFPageProxy['render']> | null = null;
        let pdf: pdfjsLib.PDFDocumentProxy | null = null;

        loadingTask.promise
            .then(async (loadedPdf) => {
                pdf = loadedPdf;
                const page = await loadedPdf.getPage(1);
                if (cancelled || !canvasRef.current) return;

                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.max(0.45, Math.min(1.2, 520 / Math.max(baseViewport.width, 1)));
                const viewport = page.getViewport({ scale });
                const canvas = canvasRef.current;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Canvas unavailable');

                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                renderTask = page.render({ canvasContext: context, viewport, canvas });
                await renderTask.promise;
                if (!cancelled) setReady(true);
            })
            .catch((error) => {
                if (cancelled || error?.name === 'RenderingCancelledException') return;
                console.warn('PDF thumbnail failed:', error);
                setFailed(true);
            });

        return () => {
            cancelled = true;
            renderTask?.cancel();
            loadingTask.destroy();
            pdf?.destroy();
        };
    }, [src]);

    if (failed) return <IconFallback filename={filename} />;

    return (
        <div className="absolute inset-0 flex items-start justify-center overflow-hidden bg-[#202124] pt-2">
            {!ready && <LoadingPreview />}
            <canvas
                ref={canvasRef}
                className={`max-w-[92%] bg-white shadow-md transition-opacity ${ready ? 'opacity-100' : 'opacity-0'}`}
                style={{ height: 'auto' }}
            />
        </div>
    );
}

function StructuredPreview({ file, src, extension }: { file: TelegramFile; src: string; extension: string }) {
    const [preview, setPreview] = useState<OfficePreview | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        async function load() {
            try {
                const response = await fetch(src, { signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                let parsed: OfficePreview;
                if (extension === 'docx' || extension === 'xlsx' || extension === 'pptx') {
                    const buffer = await response.arrayBuffer();
                    parsed = await parseOfficePreview(buffer, extension);
                } else {
                    const raw = await response.text();
                    parsed = { kind: 'text', text: extension === 'rtf' ? stripRtf(raw) : normalizeText(raw) };
                }

                if (!cancelled) setPreview(parsed);
            } catch (error) {
                if (controller.signal.aborted) return;
                console.warn(`Preview failed for ${file.name}:`, error);
                if (!cancelled) setFailed(true);
            }
        }

        load();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [extension, file.name, src]);

    if (failed) return <IconFallback filename={file.name} />;
    if (!preview) return <LoadingPreview />;

    if (preview.kind === 'sheet') return <SheetPreview rows={preview.rows} />;
    if (preview.kind === 'slide') return <SlidePreview lines={preview.lines} />;
    if (preview.kind === 'document') return <DocumentPreview lines={preview.lines} />;
    return <TextPreview text={preview.text} />;
}

function DocumentPreview({ lines }: { lines: string[] }) {
    const visibleLines = lines.filter(Boolean).slice(0, 18);
    return (
        <div className="absolute inset-0 flex items-start justify-center overflow-hidden bg-[#202124] pt-2">
            <div className="min-h-[135%] w-[86%] bg-white px-4 py-4 text-[7px] leading-[1.35] text-slate-700 shadow-md">
                {visibleLines.length > 0 ? visibleLines.map((line, index) => (
                    <p key={`${index}-${line.slice(0, 12)}`} className={`mb-1 ${index === 0 ? 'font-semibold text-slate-900' : ''}`}>
                        {line}
                    </p>
                )) : <p className="text-slate-400">Document preview</p>}
            </div>
        </div>
    );
}

function TextPreview({ text }: { text: string }) {
    return (
        <div className="absolute inset-0 flex items-start justify-center overflow-hidden bg-[#202124] pt-2">
            <pre className="min-h-[135%] w-[88%] whitespace-pre-wrap break-words bg-white px-3 py-3 font-mono text-[6.5px] leading-[1.35] text-slate-700 shadow-md">
                {text.slice(0, 5000)}
            </pre>
        </div>
    );
}

function SlidePreview({ lines }: { lines: string[] }) {
    return (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden bg-[#202124] p-3">
            <div className="flex aspect-video w-[94%] flex-col justify-center overflow-hidden bg-white px-5 py-3 text-slate-800 shadow-md">
                {lines.filter(Boolean).slice(0, 10).map((line, index) => (
                    <p key={`${index}-${line.slice(0, 12)}`} className={`${index === 0 ? 'mb-2 text-[9px] font-bold' : 'mb-1 text-[6.5px]'}`}>
                        {line}
                    </p>
                ))}
            </div>
        </div>
    );
}

function SheetPreview({ rows }: { rows: string[][] }) {
    const visibleRows = rows.slice(0, 10);
    const width = Math.min(6, Math.max(1, ...visibleRows.map((row) => row.length)));

    return (
        <div className="absolute inset-0 flex items-start justify-center overflow-hidden bg-[#202124] pt-2">
            <div className="min-h-[135%] w-[94%] overflow-hidden bg-white shadow-md">
                <table className="w-full table-fixed border-collapse text-[5.5px] leading-tight text-slate-700">
                    <tbody>
                        {visibleRows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                {Array.from({ length: width }, (_, columnIndex) => (
                                    <td
                                        key={columnIndex}
                                        className={`h-4 truncate border border-slate-200 px-1 ${rowIndex === 0 ? 'bg-emerald-50 font-semibold text-slate-900' : ''}`}
                                    >
                                        {row[columnIndex] || ''}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function normalizeText(value: string): string {
    return value
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t/g, '    ')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function stripRtf(input: string): string {
    let value = input;
    const bodyStart = value.search(/\\pard\b/);
    if (bodyStart > 0) value = value.slice(bodyStart);

    value = value
        .replace(/\\par[d]?\b ?/gi, '\n')
        .replace(/\\line\b ?/gi, '\n')
        .replace(/\\tab\b ?/gi, '    ')
        .replace(/\\u(-?\d+)\??/g, (_, raw: string) => {
            let code = Number(raw);
            if (code < 0) code += 65536;
            return Number.isFinite(code) ? String.fromCharCode(code) : '';
        })
        .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) => {
            const byte = Number.parseInt(hex, 16);
            try {
                return new TextDecoder('windows-1252').decode(new Uint8Array([byte]));
            } catch {
                return String.fromCharCode(byte);
            }
        })
        .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
        .replace(/\\[{}\\]/g, '')
        .replace(/[{}]/g, '');

    return normalizeText(value);
}

type ZipEntry = {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
};

async function parseOfficePreview(buffer: ArrayBuffer, extension: string): Promise<OfficePreview> {
    const entries = readZipEntries(buffer);

    if (extension === 'docx') {
        const xml = await readZipText(buffer, entries, 'word/document.xml');
        if (!xml) throw new Error('DOCX document.xml not found');
        const lines = extractWordParagraphs(xml);
        return { kind: 'document', lines };
    }

    if (extension === 'xlsx') {
        const sharedXml = await readZipText(buffer, entries, 'xl/sharedStrings.xml');
        const sharedStrings = sharedXml ? extractSharedStrings(sharedXml) : [];
        const firstSheet = entries
            .map((entry) => entry.name)
            .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
        if (!firstSheet) throw new Error('XLSX worksheet not found');
        const sheetXml = await readZipText(buffer, entries, firstSheet);
        if (!sheetXml) throw new Error('XLSX worksheet unreadable');
        return { kind: 'sheet', rows: extractSheetRows(sheetXml, sharedStrings) };
    }

    const firstSlide = entries
        .map((entry) => entry.name)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
    if (!firstSlide) throw new Error('PPTX slide not found');
    const slideXml = await readZipText(buffer, entries, firstSlide);
    if (!slideXml) throw new Error('PPTX slide unreadable');
    return { kind: 'slide', lines: extractSlideText(slideXml) };
}

function readZipEntries(buffer: ArrayBuffer): ZipEntry[] {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const minimum = Math.max(0, bytes.length - 65_557);
    let eocd = -1;

    for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
        if (view.getUint32(offset, true) === 0x06054b50) {
            eocd = offset;
            break;
        }
    }

    if (eocd < 0) throw new Error('ZIP directory not found');

    const entryCount = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries: ZipEntry[] = [];
    let offset = centralOffset;

    for (let index = 0; index < entryCount; index += 1) {
        if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;

        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const nameStart = offset + 46;
        const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));

        entries.push({ name, method, compressedSize, localOffset });
        offset = nameStart + nameLength + extraLength + commentLength;
    }

    return entries;
}

async function readZipText(buffer: ArrayBuffer, entries: ZipEntry[], name: string): Promise<string | null> {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return null;

    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const localOffset = entry.localOffset;
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`Invalid ZIP entry: ${name}`);
    }

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + entry.compressedSize);
    let output: Uint8Array;

    if (entry.method === 0) {
        output = compressed;
    } else if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('Browser does not support ZIP previews');
        }
        const compressedBuffer = compressed.buffer.slice(
            compressed.byteOffset,
            compressed.byteOffset + compressed.byteLength
        ) as ArrayBuffer;
        const decompressedStream = new Blob([compressedBuffer])
            .stream()
            .pipeThrough(new DecompressionStream('deflate-raw' as any));
        output = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
    } else {
        throw new Error(`Unsupported ZIP compression method ${entry.method}`);
    }

    return new TextDecoder('utf-8').decode(output);
}

function parseXml(xml: string): XMLDocument {
    return new DOMParser().parseFromString(xml, 'application/xml');
}

function textFromElements(element: Element | Document, localName: string): string[] {
    return Array.from(element.getElementsByTagNameNS('*', localName))
        .map((node) => node.textContent || '')
        .filter(Boolean);
}

function extractWordParagraphs(xml: string): string[] {
    const doc = parseXml(xml);
    const paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'p'));
    return paragraphs
        .map((paragraph) => textFromElements(paragraph, 't').join(''))
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 60);
}

function extractSharedStrings(xml: string): string[] {
    const doc = parseXml(xml);
    return Array.from(doc.getElementsByTagNameNS('*', 'si')).map((item) =>
        textFromElements(item, 't').join('')
    );
}

function extractSheetRows(xml: string, sharedStrings: string[]): string[][] {
    const doc = parseXml(xml);
    const rows = Array.from(doc.getElementsByTagNameNS('*', 'row')).slice(0, 20);

    return rows.map((row) => {
        const cells = Array.from(row.getElementsByTagNameNS('*', 'c')).slice(0, 10);
        return cells.map((cell) => {
            const type = cell.getAttribute('t');
            if (type === 'inlineStr') return textFromElements(cell, 't').join('');
            const value = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent || '';
            if (type === 's') {
                const index = Number.parseInt(value, 10);
                return Number.isFinite(index) ? sharedStrings[index] || '' : value;
            }
            return value;
        });
    });
}

function extractSlideText(xml: string): string[] {
    const doc = parseXml(xml);
    return textFromElements(doc, 't')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 40);
}
