import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type MessageBoxOptions,
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startBackend, waitForBackendReady, startRuntimeHealthCheck, type BackendHandle } from "./backend-process";
import { loadWindowState, trackAndSaveWindowState } from "./window-state";
import { ensureUserData } from "./first-run-init";
import { initDesktopLogger, cleanOldLogs, log } from "./logger";
import { pickAvailablePort } from "./port";
import { getResourcePaths, type ResourcePaths } from "./resource-paths";
import { getUserDataPaths, type UserDataPaths } from "./user-data-paths";

let backend: BackendHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let allowedAppOrigin: string | undefined;
let isQuitting = false;
let backendRestartCount = 0;
let stopHealthCheck: (() => void) | undefined;
let windowStateFile: string | undefined;
const preloadPath = join(__dirname, "preload.js");
const devIconPath = join(__dirname, "..", "build", "icon.png");
const BACKEND_START_ATTEMPTS = 5;
const BACKEND_RUNTIME_RESTART_ATTEMPTS = 2;
const isMac = process.platform === "darwin";

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "AgeWork",
            submenu: [
              {
                label: "关于 AgeWork",
                role: "about" as const,
              },
              { type: "separator" as const },
              { label: "服务", role: "services" as const },
              { type: "separator" as const },
              { label: "隐藏 AgeWork", role: "hide" as const },
              { label: "隐藏其他", role: "hideOthers" as const },
              { label: "显示全部", role: "unhide" as const },
              { type: "separator" as const },
              { label: "退出 AgeWork", role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" as const },
        { label: "重做", role: "redo" as const },
        { type: "separator" as const },
        { label: "剪切", role: "cut" as const },
        { label: "复制", role: "copy" as const },
        { label: "粘贴", role: "paste" as const },
        { label: "全选", role: "selectAll" as const },
      ],
    },
    {
      label: "显示",
      submenu: [
        { label: "刷新", role: "reload" as const },
        { label: "强制刷新", role: "forceReload" as const },
        { type: "separator" as const },
        { label: "实际大小", role: "resetZoom" as const },
        { label: "放大", role: "zoomIn" as const },
        { label: "缩小", role: "zoomOut" as const },
        { type: "separator" as const },
        { label: "全屏", role: "togglefullscreen" as const },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" as const },
        { label: "缩放", role: "zoom" as const },
        { type: "separator" as const },
        ...(isMac
          ? [{ label: "前置全部窗口", role: "front" as const }]
          : [{ label: "关闭", role: "close" as const }]),
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "日志目录",
          click: () => {
            const userData = getUserDataPaths(app.getPath("userData"));
            void shell.openPath(userData.logsDir);
          },
        },
        ...(isMac || !app.isPackaged
          ? [
              { type: "separator" as const },
              { label: "开发者工具", role: "toggleDevTools" as const },
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function loadDevIcon() {
  if (!existsSync(devIconPath)) return undefined;
  const icon = nativeImage.createFromPath(devIconPath);
  return icon.isEmpty() ? undefined : icon;
}

async function createMainWindow(port: number, windowStateFile: string): Promise<void> {
  const icon = loadDevIcon();
  allowedAppOrigin = new URL(getAppUrl(port)).origin;
  const savedState = loadWindowState(windowStateFile);
  mainWindow = new BrowserWindow({
    ...(savedState.x !== undefined ? { x: savedState.x } : {}),
    ...(savedState.y !== undefined ? { y: savedState.y } : {}),
    width: savedState.width,
    height: savedState.height,
    show: false,
    title: "AgeWork",
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    ...(isMac
      ? {
          trafficLightPosition: { x: 24, y: 18 },
        }
      : {}),
    ...(icon ? { icon } : {}),
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      plugins: false,
      preload: preloadPath,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  markWindowAsDesktopClient(mainWindow);
  if (savedState.isMaximized) mainWindow.maximize();
  trackAndSaveWindowState(mainWindow, windowStateFile);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  protectNavigation(mainWindow);
  await mainWindow.loadURL(getAppUrl(port));
}

function markWindowAsDesktopClient(win: BrowserWindow): void {
  const userAgent = win.webContents.getUserAgent();
  if (!userAgent.includes("AgeWorkDesktop/")) {
    win.webContents.setUserAgent(`${userAgent} AgeWorkDesktop/${app.getVersion()}`);
  }

  win.webContents.on("dom-ready", () => {
    void win.webContents.executeJavaScript(
      'document.documentElement.classList.add("electron");',
      true
    ).catch(() => undefined);
    void win.webContents.insertCSS(
      `
        [data-agework-client-brand="true"] {
          display: none !important;
        }

        [data-agework-client-header] {
          justify-content: flex-end !important;
        }
      `
    ).catch(() => undefined);
  });
}

function showStartupError(message: string): void {
  const win = new BrowserWindow({
    width: 640,
    height: 360,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html>
<html>
  <head><title>AgeWork failed to start</title></head>
  <body>
    <h1>AgeWork failed to start</h1>
    <pre style="white-space: pre-wrap">${escapeHtml(message)}</pre>
  </body>
</html>`
    )}`
  );
}

ipcMain.handle("agework:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return undefined;
  return result.filePaths[0];
});

ipcMain.handle(
  "agework:open-path",
  async (_event, path: unknown, relativePath: unknown) => {
    const rootPath = typeof path === "string" ? path.trim() : "";
    if (!rootPath) {
      return { ok: false, error: "路径为空" };
    }

    // relativePath 用 node:path join 而非渲染进程拼字符串,避免 Windows 下 "/" 与
    // "\" 混用。
    const targetPath =
      typeof relativePath === "string" && relativePath.trim()
        ? join(rootPath, relativePath.trim())
        : rootPath;

    if (!existsSync(targetPath)) {
      return { ok: false, error: "路径不存在或当前客户端无法访问" };
    }

    const error = await shell.openPath(targetPath);
    return error ? { ok: false, error } : { ok: true };
  }
);

async function startBackendWithPortRetries(
  resources: ResourcePaths,
  userData: UserDataPaths
): Promise<BackendHandle> {
  const attemptedPorts: number[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= BACKEND_START_ATTEMPTS; attempt += 1) {
    const port = await pickAvailablePort();
    attemptedPorts.push(port);
    const handle = startBackend(resources, userData, port);

    try {
      await waitForBackendReady(handle);
      return handle;
    } catch (error) {
      lastError = error;
      await handle.stop();
      if (attempt < BACKEND_START_ATTEMPTS) {
        await sleep(250 * attempt);
      }
    }
  }

  throw new Error(
    [
      "后端启动失败，已尝试多个本地端口。",
      `尝试端口：${attemptedPorts.join(", ")}`,
      `最后错误：${errorToMessage(lastError)}`,
      `日志文件：${join(userData.apiLogsDir, "api.log")}`,
    ].join("\n")
  );
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function protectNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

function isAllowedAppUrl(url: string): boolean {
  if (!allowedAppOrigin) return false;
  try {
    return new URL(url).origin === allowedAppOrigin;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    void shell.openExternal(url);
  }
}

function getAppUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function installBackendExitHandler(
  handle: BackendHandle,
  resources: ResourcePaths,
  userData: UserDataPaths
): void {
  handle.process.once("exit", (code, signal) => {
    if (isQuitting) return;
    log.warn(`Backend exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
    if (backend?.process.pid === handle.process.pid) {
      backend = undefined;
    }
    void recoverBackendAfterExit(resources, userData, code, signal);
  });
}

async function recoverBackendAfterExit(
  resources: ResourcePaths,
  userData: UserDataPaths,
  code: number | null,
  signal: NodeJS.Signals | null
): Promise<void> {
  const exitDetail = `退出码：${code ?? "null"}，信号：${signal ?? "null"}\n日志文件：${join(
    userData.apiLogsDir,
    "api.log"
  )}`;

  if (backendRestartCount < BACKEND_RUNTIME_RESTART_ATTEMPTS) {
    backendRestartCount += 1;
    log.info(`Attempting backend restart (${backendRestartCount}/${BACKEND_RUNTIME_RESTART_ATTEMPTS})`);
    try {
      await sleep(500 * backendRestartCount);
      if (isQuitting) return;
      backend = await startBackendWithPortRetries(resources, userData);
      installBackendExitHandler(backend, resources, userData);
      restartHealthCheck(backend);
      allowedAppOrigin = new URL(getAppUrl(backend.port)).origin;
      await mainWindow?.loadURL(getAppUrl(backend.port));
      return;
    } catch (error) {
      await showBackendExitDialog(
        `${exitDetail}\n\n自动重启失败：${errorToMessage(error)}`,
        resources,
        userData
      );
      return;
    }
  }

  await showBackendExitDialog(
    `${exitDetail}\n\n已自动重启 ${BACKEND_RUNTIME_RESTART_ATTEMPTS} 次，仍然失败。`,
    resources,
    userData
  );
}

async function showBackendExitDialog(
  detail: string,
  resources: ResourcePaths,
  userData: UserDataPaths
): Promise<void> {
  const options: MessageBoxOptions = {
    type: "error",
    title: "AgeWork 后端已退出",
    message: "AgeWork 后端进程已退出。",
    detail,
    buttons: ["退出", "重试"],
    cancelId: 0,
    defaultId: 1,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);

  if (response !== 1) {
    stopBackendForQuit();
    app.quit();
    return;
  }

  backendRestartCount = 0;
  try {
    backend = await startBackendWithPortRetries(resources, userData);
    installBackendExitHandler(backend, resources, userData);
    restartHealthCheck(backend);
    allowedAppOrigin = new URL(getAppUrl(backend.port)).origin;
    await mainWindow?.loadURL(getAppUrl(backend.port));
  } catch (error) {
    showStartupError(errorToMessage(error));
  }
}

function restartHealthCheck(handle: BackendHandle): void {
  stopHealthCheck?.();
  stopHealthCheck = startRuntimeHealthCheck(handle.port, () => {
    if (isQuitting) return;
    log.error("Health check failed, stopping backend for restart");
    void backend?.stop();
  });
}

function stopBackendForQuit(): void {
  isQuitting = true;
  stopHealthCheck?.();
  stopHealthCheck = undefined;
  const handle = backend;
  backend = undefined;
  void handle?.stop();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.setName("AgeWork");
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    buildAppMenu();

    const icon = loadDevIcon();
    if (icon && isMac) {
      app.dock?.setIcon(icon);
    }

    const repoRoot = join(__dirname, "..", "..", "..");
    const userData = getUserDataPaths(app.getPath("userData"));
    windowStateFile = userData.windowStateFile;
    const resources = getResourcePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot,
    });

    try {
      ensureUserData(userData, resources);
      initDesktopLogger(userData.desktopLogsDir);
      cleanOldLogs(userData.logsDir);
      log.info(`AgeWork desktop starting (version ${app.getVersion()})`);
      backend = await startBackendWithPortRetries(resources, userData);
      backendRestartCount = 0;
      log.info(`Backend started on port ${backend.port}`);
      installBackendExitHandler(backend, resources, userData);
      restartHealthCheck(backend);
      await createMainWindow(backend.port, userData.windowStateFile);
    } catch (error) {
      log.error(`Startup failed: ${errorToMessage(error)}`);
      await backend?.stop();
      backend = undefined;
      showStartupError(error instanceof Error ? error.message : String(error));
    }
  });
}

app.on("window-all-closed", () => {
  if (isMac) return; // macOS: keep app running in Dock when all windows are closed
  stopBackendForQuit();
  app.quit();
});

app.on("activate", () => {
  // macOS: re-open main window when clicking the Dock icon with no windows open
  if (isMac && !mainWindow && backend && windowStateFile) {
    void createMainWindow(backend.port, windowStateFile);
  }
});

app.on("before-quit", () => {
  stopBackendForQuit();
});

app.on("will-quit", () => {
  stopBackendForQuit();
});

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
