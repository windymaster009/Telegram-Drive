import { Database, HardDrive, MemoryStick, Server } from 'lucide-react';
import type { ServerResources } from '@shared/nas';
import { formatBytes } from '../../utils';

interface ServerResourcesPanelProps {
    resources: ServerResources | null;
    loading?: boolean;
}

function percent(used: number, total: number) {
    if (!total) return 0;
    return Math.min(100, Math.max(0, (used / total) * 100));
}

function ResourceCard({
    icon,
    label,
    value,
    subtext,
    progress,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    subtext: string;
    progress?: number;
}) {
    return (
        <div className="min-w-0 rounded-xl border border-telegram-border bg-telegram-surface/70 px-3 py-3 shadow-sm">
            <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-telegram-primary/10 text-telegram-primary">
                    {icon}
                </div>
                <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-telegram-subtext">{label}</p>
                    <p className="truncate text-sm font-semibold text-telegram-text">{value}</p>
                </div>
            </div>
            <p className="mt-2 truncate text-[11px] text-telegram-subtext">{subtext}</p>
            {typeof progress === 'number' && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-telegram-hover">
                    <div
                        className="h-full rounded-full bg-telegram-primary transition-all duration-500"
                        style={{ width: `${progress}%` }}
                    />
                </div>
            )}
        </div>
    );
}

export function ServerResourcesPanel({ resources, loading = false }: ServerResourcesPanelProps) {
    if (!resources && loading) {
        return (
            <div className="px-3 pt-3 sm:px-6 sm:pt-4">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                    {[0, 1, 2, 3].map((item) => (
                        <div key={item} className="h-[94px] animate-pulse rounded-xl bg-telegram-surface/60" />
                    ))}
                </div>
            </div>
        );
    }

    if (!resources) return null;

    const memoryPercent = percent(resources.memory_used, resources.memory_total);
    const storagePercent = percent(resources.storage_used, resources.storage_total);
    const cachePercent = percent(resources.stream_cache_used, resources.stream_cache_limit);

    return (
        <div className="px-3 pt-3 sm:px-6 sm:pt-4">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <ResourceCard
                    icon={<Server className="h-4 w-4" />}
                    label="Server"
                    value={resources.hostname || 'Telegram Drive'}
                    subtext="Live hosting resource monitor"
                />
                <ResourceCard
                    icon={<MemoryStick className="h-4 w-4" />}
                    label="RAM"
                    value={`${formatBytes(resources.memory_used)} / ${formatBytes(resources.memory_total)}`}
                    subtext={`${memoryPercent.toFixed(0)}% used · ${formatBytes(resources.memory_available)} free`}
                    progress={memoryPercent}
                />
                <ResourceCard
                    icon={<HardDrive className="h-4 w-4" />}
                    label="Server Storage"
                    value={`${formatBytes(resources.storage_used)} / ${formatBytes(resources.storage_total)}`}
                    subtext={`${formatBytes(resources.storage_available)} free · ${resources.storage_mount || 'server disk'}`}
                    progress={storagePercent}
                />
                <ResourceCard
                    icon={<Database className="h-4 w-4" />}
                    label="Video Cache"
                    value={`${formatBytes(resources.stream_cache_used)} / ${formatBytes(resources.stream_cache_limit)}`}
                    subtext={`${cachePercent.toFixed(0)}% of Pi cache limit used`}
                    progress={cachePercent}
                />
            </div>
        </div>
    );
}
