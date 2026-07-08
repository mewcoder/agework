import { memo, useEffect, useState } from "react";
import { AlertCircle, FileWarning, Eye, Code } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useWorkspaceFileContent } from "@/hooks/use-workspace";

// ── 扩展名 → 语言映射(常见几十种,未命中回退 text) ──

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", css: "css", scss: "scss", html: "html",
  vue: "vue", svelte: "svelte",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", h: "c",
  cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  sql: "sql", dockerfile: "dockerfile", makefile: "makefile",
  md: "markdown", markdown: "markdown",
};

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
]);

function extOf(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function isImage(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(path));
}

function isMarkdown(path: string): boolean {
  const ext = extOf(path);
  return ext === "md" || ext === "markdown";
}

// ── shiki highlighter 单例(懒加载,不进首屏 chunk) ──

type ShikiHighlighter = Awaited<
  ReturnType<typeof import("shiki").createHighlighter>
>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((m) =>
      m.createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: [
          "typescript", "tsx", "javascript", "jsx", "json", "css",
          "html", "python", "ruby", "go", "rust", "java", "bash",
          "yaml", "markdown", "sql", "xml", "toml",
        ],
      }),
    );
  }
  return highlighterPromise;
}

// ── 代码高亮组件 ──

const CodePreview = memo(function CodePreview({
  path,
  content,
  truncated,
}: {
  path: string;
  content: string;
  truncated: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const lang = EXT_LANG[extOf(path)] ?? "text";
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          const result = hl.codeToHtml(content, {
            lang,
            themes: { light: "github-light", dark: "github-dark" },
          });
          setHtml(result);
        } catch {
          // 语言不支持时回退到纯文本
          setHtml(`<pre class="shiki-fallback"><code>${escapeHtml(content)}</code></pre>`);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(`<pre class="shiki-fallback"><code>${escapeHtml(content)}</code></pre>`);
      });
    return () => {
      cancelled = true;
    };
  }, [path, content]);

  if (!html) {
    return <Skeleton className="h-full w-full" />;
  }

  return (
    <div className="relative h-full overflow-auto">
      {truncated && (
        <div className="sticky top-0 z-10 bg-warning/10 px-3 py-1 text-xs text-warning-foreground border-b border-warning/20">
          文件过大,仅显示前 1MiB
        </div>
      )}
      <div
        className="text-xs [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:m-0"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

// ── Markdown 预览(使用 streamdown) ──

const MarkdownPreview = memo(function MarkdownPreview({
  content,
  truncated,
}: {
  content: string;
  truncated: boolean;
}) {
  return (
    <div className="relative h-full overflow-auto">
      {truncated && (
        <div className="sticky top-0 z-10 bg-warning/10 px-3 py-1 text-xs text-warning-foreground border-b border-warning/20">
          文件过大,仅显示前 1MiB
        </div>
      )}
      <div className="p-3 text-sm">
        <StreamdownContent content={content} />
      </div>
    </div>
  );
});

function StreamdownContent({ content }: { content: string }) {
  // streamdown 的 Streamdown 组件
  const [Streamdown, setStreamdown] = useState<
    React.ComponentType<{ children: string }> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    import("streamdown").then((m) => {
      if (!cancelled) setStreamdown(() => m.Streamdown);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Streamdown) return <Skeleton className="h-full w-full" />;
  return <Streamdown>{content}</Streamdown>;
}

// ── Markdown 预览/源码切换 ──

const MarkdownPreviewWithToggle = memo(function MarkdownPreviewWithToggle({
  path,
  content,
  truncated,
}: {
  path: string;
  content: string;
  truncated: boolean;
}) {
  const [showSource, setShowSource] = useState(false);

  return (
    <div className="relative h-full">
      {/* 切换按钮 */}
      <div className="absolute right-2 top-2 z-20">
        <TooltipIconButton
          tooltip={showSource ? "切换到预览" : "切换到源码"}
          side="left"
          className="size-6 bg-background/80 backdrop-blur-sm"
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? (
            <Eye className="size-3" />
          ) : (
            <Code className="size-3" />
          )}
        </TooltipIconButton>
      </div>
      {showSource ? (
        <CodePreview path={path} content={content} truncated={truncated} />
      ) : (
        <MarkdownPreview content={content} truncated={truncated} />
      )}
    </div>
  );
});

// ── 图片预览 ──

function ImagePreview({ content }: { content: string }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img src={content} alt="preview" className="max-h-full max-w-full object-contain" />
    </div>
  );
}

// ── 主预览组件 ──

export function WorkspaceFilePreview({
  workspaceId,
  path,
}: {
  workspaceId: string;
  path: string | undefined;
}) {
  const { data, isLoading, error } = useWorkspaceFileContent(
    workspaceId,
    path,
  );

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        选择文件以预览
      </div>
    );
  }

  if (isLoading) {
    return <Skeleton className="h-full w-full" />;
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error instanceof Error ? error.message : "读取文件失败"}</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        无内容
      </div>
    );
  }

  if (isImage(path) && data.encoding === "base64") {
    return <ImagePreview content={data.content} />;
  }

  if (isMarkdown(path) && data.encoding === "utf8") {
    return (
      <MarkdownPreviewWithToggle
        path={path}
        content={data.content}
        truncated={data.truncated}
      />
    );
  }

  if (data.encoding === "utf8") {
    return <CodePreview path={path} content={data.content} truncated={data.truncated} />;
  }

  // base64 但不是图片 → 不应该到这里,后端会拒绝
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <FileWarning className="size-4 shrink-0" />
        <span>不支持的文件类型</span>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
