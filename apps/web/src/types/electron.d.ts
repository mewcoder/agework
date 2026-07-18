export {};

declare global {
  interface Window {
    agework?: {
      selectDirectory?: () => Promise<string | undefined>;
      openPath?: (
        path: string,
        relativePath?: string,
      ) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}
