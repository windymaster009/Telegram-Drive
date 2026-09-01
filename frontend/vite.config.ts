import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function webRuntimePlugin(enabled: boolean): Plugin {
  return {
    name: "telegram-drive-web-runtime",
    enforce: "pre",
    transform(code, id) {
      if (!enabled) return null;

      if (id.endsWith("/src/App.tsx")) {
        const desktopOnlyGate = `      ) : !runningInDesktop ? (\n        <WebDisabledPage />\n      ) : googleLoading ? (`;
        if (!code.includes(desktopOnlyGate)) {
          throw new Error("Telegram Drive web build could not locate the desktop-only app gate");
        }

        const desktopFolderCatalog = `    queryFn: async () => {\n      const storedFolders = await loadStoredTelegramFolders();\n\n      try {\n        await invoke<boolean>("cmd_check_connection");\n        const scannedFolders = await invoke<TelegramFolder[]>("cmd_scan_folders", {\n          accessToken: nasSession.getAccessToken(),\n          actor: {\n            userId: me.user.id,\n            displayName: me.user.display_name,\n            email: me.user.email || me.user.username,\n            role: me.user.role,\n          },\n        });\n        return mergeTelegramFolders(storedFolders, scannedFolders);\n      } catch {\n        return storedFolders;\n      }\n    },`;
        if (!code.includes(desktopFolderCatalog)) {
          throw new Error("Telegram Drive web build could not locate the desktop folder catalog loader");
        }

        const webFolderCatalog = `    queryFn: async () => {\n      let storedFolders: TelegramFolder[] = [];\n      try {\n        const raw = window.localStorage.getItem("telegram-drive:folders");\n        const parsed = raw ? JSON.parse(raw) : [];\n        if (Array.isArray(parsed)) {\n          storedFolders = parsed\n            .filter((folder) => folder && Number.isFinite(Number(folder.id)))\n            .map((folder) => ({ ...folder, id: Number(folder.id) }));\n        }\n      } catch {\n        storedFolders = [];\n      }\n\n      try {\n        const scannedFolders = await nasApi.scanTelegramFolders();\n        return mergeTelegramFolders(storedFolders, scannedFolders);\n      } catch {\n        return storedFolders;\n      }\n    },`;

        return code
          .replace(desktopOnlyGate, `      ) : googleLoading ? (`)
          .replace(desktopFolderCatalog, webFolderCatalog);
      }

      if (id.endsWith("/src/lib/nasApi.ts")) {
        const desktopFallback = `  const currentHost = window.location.hostname;\n  const host =\n    !currentHost || currentHost === "tauri.localhost" || currentHost === "localhost"\n      ? "localhost"\n      : currentHost;\n  return \`http://\${host}:14201\`;`;
        if (!code.includes(desktopFallback)) {
          throw new Error("Telegram Drive web build could not locate the desktop API fallback");
        }
        return code.replace(desktopFallback, "  return window.location.origin;");
      }

      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const webMode = mode === "web";

  return {
    plugins: [webRuntimePlugin(webMode), react()],
    // The XLSX viewer uses a code-split Web Worker. Vite defaults workers to
    // IIFE output, which Rollup cannot use once that worker has multiple chunks.
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@shared": fileURLToPath(new URL("../shared/src", import.meta.url)),
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/../backend/src-tauri/**"],
      },
    },
  };
});