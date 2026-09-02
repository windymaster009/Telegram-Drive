import { useEffect, useMemo, useState } from 'react';
import type { TelegramFile } from '@shared/telegram';
import { nasApi } from '../../lib/nasApi';
import { ExcelWorkbookViewer } from './ExcelWorkbookViewer';
import { WordDocumentViewer } from './WordDocumentViewer';

interface DocumentViewerProps {
    file: TelegramFile;
    activeFolderId: number | null;
}

type DocumentPreview =
    | { kind: 'document'; lines: string[] }
    | { kind: 'slide'; lines: string[] }
    | { kind: 'text'; text: string };

const TEXT_EXTENSIONS = new Set([
    'txt', 'rtf', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'csv', 'ini', 'conf',
    'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'html', 'css', 'sql', 'sh', 'ps1',
]);
const OFFICE_EXTENSIONS = new Set(['docx', 'pptx']);
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls']);
const MAX_TEXT_BYTES = 8_000_000;
const MAX_OFFICE_BYTES = 40_000_000;

function getExtension(filename: string): string {
    const name = filename.split('/').pop() || filename;
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isDocumentPreviewFile(filename: string): boolean {
    const extension = getExtension(filename);
    return TEXT_EXTENSIONS.has(extension)
        || OFFICE_EXTENSIONS.has(extension)
        || SPREADSHEET_EXTENSIONS.has(extension);
}

export function DocumentViewer({ file, activeFolderId }: DocumentViewerProps) {
    const extension = useMemo(() => getExtension(file.name), [file.name]);
    const [preview, setPreview] = useState<DocumentPreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const isSpreadsheet = SPREADSHEET_EXTENSIONS.has(extension);
    const isWordDocument = extension === 'docx';

    useEffect(() => {
        if (isSpreadsheet || isWordDocument) {
            setPreview(null);
            setError(null);
            return;
        }

        const controller = new AbortController();
        let cancelled = false;

        setPreview(null);
        setError(null);

        async function load() {
            try {
                if (file.text_content && TEXT_EXTENSIONS.has(extension)) {
                    const text = extension === 'rtf'
                        ? stripRtf(file.text_content)
                        : normalizeText(file.text_content);
                    if (!cancelled) setPreview({ kind: 'text', text });
                    return;
                }

                if (TEXT_EXTENSIONS.has(extension) && file.size > MAX_TEXT_BYTES) {
                    throw new Error('This text file is too large for an in-browser preview. Download it instead.');
                }
                if (OFFICE_EXTENSIONS.has(extension) && file.size > MAX_OFFICE_BYTES) {
                    throw new Error('This Office file is too large for an in-browser preview. Download it instead.');
                }

                const response = await fetch(nasApi.streamUrl(activeFolderId, file.id), {
                    signal: controller.signal,
                });
                if (!response.ok) {
                    throw new Error(`Preview request failed (HTTP ${response.status})`);
                }

                let parsed: DocumentPreview;
                if (OFFICE_EXTENSIONS.has(extension)) {
                    parsed = await parseOfficePreview(await response.arrayBuffer(), extension);
                } else {
                    const raw = await response.text();
                    parsed = {
                        kind: 'text',
                        text: extension === 'rtf' ? stripRtf(raw) : normalizeText(raw),
                    };
                }

                if (!cancelled) setPreview(parsed);
            } catch (err) {
                if (controller.signal.aborted) return;
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            }
        }

        load();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [activeFolderId, extension, file.id, file.name, file.size, file.text_content, isSpreadsheet, isWordDocument]);

    if (isWordDocument) {
        return <WordDocumentViewer file={file} activeFolderId={activeFolderId} />;
    }

    if (isSpreadsheet) {
        return <ExcelWorkbookViewer file={file} activeFolderId={activeFolderId} />;
    }

    if (error) {
        return (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-5 text-center text-red-200">
                <div className="font-semibold">Preview Error</div>
                <div className="mt-1 text-sm text-red-200/80">{error}</div>
            </div>
        );
    }

    if (!preview) {
        return (
            <div className="flex flex-col items-center gap-3 text-white/70">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-telegram-primary border-t-transparent" />
                <span className="text-sm">Loading document from Telegram...</span>
            </div>
        );
    }

    if (preview.kind === 'slide') return <FullSlide lines={preview.lines} />;
    if (preview.kind === 'document') return <FullDocument lines={preview.lines} />;
    return <FullText text={preview.text} />;
}

function FullDocument({ lines }: { lines: string[] }) {
    return (
        <div className="max-h-[78vh] w-[min(860px,82vw)] overflow-auto rounded-md bg-[#202124] p-4 shadow-2xl custom-scrollbar">
            <article className="mx-auto min-h-[72vh] max-w-[760px] bg-white px-12 py-12 text-[15px] leading-7 text-slate-800 shadow-xl sm:px-16">
                {lines.length > 0 ? lines.map((line, index) => (
                    <p
                        key={`${index}-${line.slice(0, 24)}`}
                        className={`${index === 0 ? 'font-semibold text-slate-950' : ''} mb-3 whitespace-pre-wrap break-words`}
                    >
                        {line}
                    </p>
                )) : <p className="text-slate-400">This document has no extractable text.</p>}
            </article>
        </div>
    );
}

function FullText({ text }: { text: string }) {
    return (
        <div className="max-h-[78vh] w-[min(960px,84vw)] overflow-auto rounded-md bg-[#202124] p-4 shadow-2xl custom-scrollbar">
            <pre className="mx-auto min-h-[68vh] max-w-[860px] whitespace-pre-wrap break-words bg-white px-10 py-10 font-mono text-sm leading-6 text-slate-800 shadow-xl">
                {text || 'This file is empty.'}
            </pre>
        </div>
    );
}

function FullSlide({ lines }: { lines: string[] }) {
    return (
        <div className="max-h-[78vh] w-[min(1100px,86vw)] overflow-auto rounded-md bg-[#202124] p-5 shadow-2xl custom-scrollbar">
            <div className="mx-auto flex aspect-video max-w-[1000px] flex-col justify-center overflow-hidden bg-white px-16 py-12 text-slate-800 shadow-xl">
                {lines.length > 0 ? lines.map((line, index) => (
                    <p
                        key={`${index}-${line.slice(0, 24)}`}
                        className={index === 0 ? 'mb-6 text-3xl font-bold' : 'mb-3 text-lg'}
                    >
                        {line}
                    </p>
                )) : <p className="text-slate-400">This slide has no extractable text.</p>}
            </div>
        </div>
    );
}

function normalizeText(value: string): string {
    return value
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\t/g, '    ')
        .replace(/\n{5,}/g, '\n\n\n')
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

async function parseOfficePreview(buffer: ArrayBuffer, extension: string): Promise<DocumentPreview> {
    const entries = readZipEntries(buffer);

    if (extension === 'docx') {
        const xml = await readZipText(buffer, entries, 'word/document.xml');
        if (!xml) throw new Error('DOCX document content was not found.');
        return { kind: 'document', lines: extractWordParagraphs(xml) };
    }

    const firstSlide = entries
        .map((entry) => entry.name)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
    if (!firstSlide) throw new Error('PPTX slide was not found.');

    const slideXml = await readZipText(buffer, entries, firstSlide);
    if (!slideXml) throw new Error('PPTX slide could not be read.');
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
    if (eocd < 0) throw new Error('Office ZIP directory was not found.');

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
        throw new Error(`Invalid Office ZIP entry: ${name}`);
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
            throw new Error('This browser cannot unpack Office previews.');
        }
        const compressedBuffer = compressed.buffer.slice(
            compressed.byteOffset,
            compressed.byteOffset + compressed.byteLength,
        ) as ArrayBuffer;
        const decompressed = new Blob([compressedBuffer])
            .stream()
            .pipeThrough(new DecompressionStream('deflate-raw' as any));
        output = new Uint8Array(await new Response(decompressed).arrayBuffer());
    } else {
        throw new Error(`Unsupported Office compression method ${entry.method}.`);
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
    return Array.from(doc.getElementsByTagNameNS('*', 'p'))
        .map((paragraph) => textFromElements(paragraph, 't').join(''))
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 500);
}

function extractSlideText(xml: string): string[] {
    const doc = parseXml(xml);
    return textFromElements(doc, 't')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 200);
}
