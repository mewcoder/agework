import { useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileIcon } from "lucide-react";
import type { Unstable_TriggerItem } from "@assistant-ui/react";
import { workspacesApi } from "@/api/workspaces";
import { fuzzyMatch } from "@/lib/fuzzy-match";
import { useCallback } from "react";

// ── Query key ──────────────────────────────────────────────────────────────

export const FILE_INDEX_KEY = ["workspace-file-index"] as const;

// ── Adapter type ───────────────────────────────────────────────────────────

export type FileMentionAdapter = {
  adapter: {
    categories: () => never[];
    categoryItems: () => never[];
    search: (query: string) => Unstable_TriggerItem[];
  };
  fallbackIcon: typeof FileIcon;
  /** The full list of known file paths (for existence check in overlay). */
  files: string[];
  /** True while the file list is loading from the server. */
  isLoading: boolean;
  /** Manually refresh the file list (SPEC §3.1 — refresh is user-triggered). */
  refresh: () => void;
};

/**
 * Hook: fetches the workspace file index (git ls-files) once per workspace,
 * caches it globally via TanStack Query, and creates a trigger adapter that
 * does fuzzy matching in memory (no network per keystroke).
 *
 * - **Search**: always in-browser memory (fuzzyMatch), zero network per keystroke.
 * - **Fetch**: one HTTP call per workspace, cached with long staleTime.
 * - **Refresh**: user-triggered via `refresh()` (SPEC §3.1). Also auto-fetched
 *   when the workspace changes.
 * - **gcTime**: TanStack Query auto-evicts the cache when no one is using it.
 */
export function useFileMentionAdapter(
  workspaceId: string | undefined,
): FileMentionAdapter {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: workspaceId
      ? [...FILE_INDEX_KEY, workspaceId]
      : ["workspace-file-index", "disabled"],
    queryFn: () => workspacesApi.searchFiles(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 10 * 60 * 1000, // 10 min — cache aggressively, refresh is manual
    gcTime: 5 * 60 * 1000, // 5 min after last observer leaves
    retry: false,
    select: (data) => data.list,
  });

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    qc.invalidateQueries({ queryKey: [...FILE_INDEX_KEY, workspaceId] });
  }, [qc, workspaceId]);

  const files = data ?? [];
  const filesRef = useRef(files);
  filesRef.current = files;

  const adapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const results = fuzzyMatch(query, filesRef.current, 20);
        return results.map(
          ({ path, filename, dir }): Unstable_TriggerItem => ({
            id: path,
            type: "file",
            label: filename,
            description: dir,
          }),
        );
      },
    }),
    [],
  );

  return { adapter, fallbackIcon: FileIcon, files, isLoading, refresh };
}
