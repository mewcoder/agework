import { screen, type BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";

type SavedState = {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
};

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
};

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const VISIBLE_MARGIN = 100;

/** Reads saved window state from disk. Returns undefined position when the saved position is off-screen. */
export function loadWindowState(filePath: string): WindowState {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const saved = JSON.parse(raw) as Partial<SavedState>;

    const width = Number(saved.width) || DEFAULT_WIDTH;
    const height = Number(saved.height) || DEFAULT_HEIGHT;
    const isMaximized = saved.isMaximized === true;

    if (
      typeof saved.x === "number" &&
      typeof saved.y === "number" &&
      isVisibleOnScreen({ x: saved.x, y: saved.y, width, height })
    ) {
      return { x: saved.x, y: saved.y, width, height, isMaximized };
    }

    return { width, height, isMaximized };
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, isMaximized: false };
  }
}

/** Tracks resize/move events and saves state to disk on window close. */
export function trackAndSaveWindowState(win: BrowserWindow, filePath: string): void {
  let bounds = win.getBounds();

  const updateBounds = () => {
    if (!win.isMaximized() && !win.isMinimized()) {
      bounds = win.getBounds();
    }
  };

  win.on("resize", updateBounds);
  win.on("move", updateBounds);

  win.on("close", () => {
    try {
      const state: SavedState = { ...bounds, isMaximized: win.isMaximized() };
      writeFileSync(filePath, JSON.stringify(state), "utf-8");
    } catch {
      // ignore write errors — non-critical
    }
  });
}

function isVisibleOnScreen(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some(({ bounds: db }) =>
    bounds.x + bounds.width - VISIBLE_MARGIN >= db.x &&
    bounds.x + VISIBLE_MARGIN <= db.x + db.width &&
    bounds.y + bounds.height - VISIBLE_MARGIN >= db.y &&
    bounds.y + VISIBLE_MARGIN <= db.y + db.height
  );
}
