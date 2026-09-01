import { useEffect, useState } from 'react';

const isTauriRuntime = () =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Reports whether the client has usable network access.
 *
 * Desktop/Tauri uses the lightweight Rust Telegram reachability command.
 * Browser/Web uses the browser's online state so a missing Tauri runtime does
 * not incorrectly mark the NAS connection as offline.
 */
export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(() =>
        typeof navigator === 'undefined' ? true : navigator.onLine
    );

    useEffect(() => {
        if (!isTauriRuntime()) {
            const updateBrowserStatus = () => setIsOnline(navigator.onLine);
            updateBrowserStatus();
            window.addEventListener('online', updateBrowserStatus);
            window.addEventListener('offline', updateBrowserStatus);

            return () => {
                window.removeEventListener('online', updateBrowserStatus);
                window.removeEventListener('offline', updateBrowserStatus);
            };
        }

        let cancelled = false;
        let interval: number | undefined;

        const startDesktopPolling = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const checkNetwork = async () => {
                    try {
                        const available = await invoke<boolean>('cmd_is_network_available');
                        if (!cancelled) setIsOnline(available);
                    } catch {
                        if (!cancelled) setIsOnline(false);
                    }
                };

                await checkNetwork();
                interval = window.setInterval(checkNetwork, 10_000);
            } catch {
                if (!cancelled) setIsOnline(false);
            }
        };

        startDesktopPolling();

        return () => {
            cancelled = true;
            if (interval !== undefined) window.clearInterval(interval);
        };
    }, []);

    return isOnline;
}
