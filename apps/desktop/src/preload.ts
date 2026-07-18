import { contextBridge, ipcRenderer } from "electron";

// Explicit allowlists — only channels listed here can be called from the renderer.
// Attempting to invoke or subscribe to any other channel will throw at runtime.
const ALLOWED_INVOKE_CHANNELS = new Set([
  "agework:select-directory",
  "agework:open-path",
]);
const ALLOWED_EVENT_CHANNELS = new Set<string>([
  // Future push-event channels go here, e.g. "agework:backend-status"
]);

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`[preload] Unauthorized invoke channel: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel: string, listener: (...args: unknown[]) => void): () => void {
  if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
    throw new Error(`[preload] Unauthorized event channel: ${channel}`);
  }
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld("agework", {
  selectDirectory: async () => {
    const selected = await invoke("agework:select-directory");
    return typeof selected === "string" && selected.trim() ? selected : undefined;
  },
  openPath: async (path: string, relativePath?: string) => {
    return invoke("agework:open-path", path, relativePath);
  },
  subscribe,
});

function markElectronDocument(): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  document.documentElement.classList.add("electron");
}

markElectronDocument();
window.addEventListener("DOMContentLoaded", markElectronDocument, { once: true });
