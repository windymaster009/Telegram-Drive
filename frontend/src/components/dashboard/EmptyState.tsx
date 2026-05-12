import { Upload } from 'lucide-react';

interface EmptyStateProps {
    onUpload?: () => void;
}

export function EmptyState({ onUpload }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center px-4 py-12 text-center sm:px-8 sm:py-20">
            <svg
                className="mb-6 h-32 w-32 sm:mb-8 sm:h-48 sm:w-48"
                viewBox="0 0 200 200"
                fill="none"
            >
                <ellipse cx="100" cy="120" rx="70" ry="40" className="fill-blue-100 dark:fill-telegram-primary/5 opacity-50 dark:opacity-30" />
                <path
                    d="M40 80 L40 140 C40 145 44 150 50 150 L150 150 C156 150 160 145 160 140 L160 80 Z"
                    className="fill-white dark:fill-[#1e3a5f] stroke-blue-200 dark:stroke-telegram-primary/30"
                    strokeWidth="1"
                />
                <path
                    d="M40 80 L40 70 C40 65 44 60 50 60 L80 60 L90 70 L90 80 Z"
                    className="fill-white dark:fill-[#1e3a5f] stroke-blue-200 dark:stroke-telegram-primary/30"
                    strokeWidth="1"
                />
                <circle cx="100" cy="110" r="20" className="fill-blue-50 dark:fill-telegram-primary/10 stroke-blue-300 dark:stroke-telegram-primary/50" strokeWidth="2" strokeDasharray="4 2" />
                <path d="M100 100 L100 120 M90 110 L110 110" className="stroke-telegram-primary" strokeWidth="2" strokeLinecap="round" />
                <g className="animate-pulse">
                    <rect x="130" y="50" width="25" height="30" rx="3" className="fill-blue-500" />
                    <rect x="135" y="56" width="15" height="2" rx="1" className="fill-white/80" />
                    <rect x="135" y="62" width="12" height="2" rx="1" className="fill-white/80" />
                </g>

                <g opacity="0.6">
                    <rect x="45" y="40" width="20" height="25" rx="3" className="fill-gray-300 dark:fill-gray-500" />
                    <rect x="49" y="45" width="12" height="2" rx="1" className="fill-white/80" />
                    <rect x="49" y="50" width="8" height="2" rx="1" className="fill-white/80" />
                </g>
            </svg>

            <h3 className="mb-2 text-lg font-semibold text-telegram-text sm:text-xl">
                This folder is empty
            </h3>
            <p className="mb-6 max-w-xs text-sm text-telegram-subtext">
                {onUpload ? "Drag and drop files here, or click the button below to upload from your computer." : "This folder is available to view, but uploads are disabled for your account."}
            </p>

            {onUpload && (
                <button
                    onClick={onUpload}
                    className="inline-flex items-center gap-2 rounded-xl bg-telegram-primary px-5 py-3 font-medium text-black shadow-lg shadow-telegram-primary/20 transition-all hover:scale-105 hover:bg-telegram-primary/90 sm:px-6"
                >
                    <Upload className="w-5 h-5" />
                    Upload Files
                </button>
            )}

            <p className="mt-6 text-xs text-telegram-subtext/50">
                Tip: Use <kbd className="px-1.5 py-0.5 bg-telegram-hover rounded text-telegram-subtext">Cmd + F</kbd> to search
            </p>
        </div>
    );
}
