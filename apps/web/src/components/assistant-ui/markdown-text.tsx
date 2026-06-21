"use client";

import {
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
} from "@assistant-ui/react-streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import "katex/dist/katex.min.css";
import { memo } from "react";
import { type ThemeInput } from "streamdown";

import { cn } from "@/lib/utils";

const streamdownPlugins = { code, cjk, math, mermaid };
const shikiTheme: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];

const MarkdownTextImpl = () => {
  return (
    <StreamdownTextPrimitive
      className="aui-md text-[15px] leading-6"
      plugins={streamdownPlugins}
      shikiTheme={shikiTheme}
      controls={true}
      components={defaultComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = {
  h1: ({ className, ...props }: Record<string, unknown>) => (
    <h1
      className={cn(
        "aui-md-h1 mb-2 scroll-m-20 text-lg font-semibold leading-7 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  h2: ({ className, ...props }: Record<string, unknown>) => (
    <h2
      className={cn(
        "aui-md-h2 mt-3 mb-1.5 scroll-m-20 text-base font-semibold leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  h3: ({ className, ...props }: Record<string, unknown>) => (
    <h3
      className={cn(
        "aui-md-h3 mt-2.5 mb-1 scroll-m-20 text-[15px] font-semibold leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  h4: ({ className, ...props }: Record<string, unknown>) => (
    <h4
      className={cn(
        "aui-md-h4 mt-2 mb-1 scroll-m-20 text-[15px] font-medium leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  h5: ({ className, ...props }: Record<string, unknown>) => (
    <h5
      className={cn(
        "aui-md-h5 mt-2 mb-1 text-[15px] font-medium leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  h6: ({ className, ...props }: Record<string, unknown>) => (
    <h6
      className={cn(
        "aui-md-h6 mt-2 mb-1 text-[15px] font-medium leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLHeadingElement>)}
    />
  ),
  p: ({ className, ...props }: Record<string, unknown>) => (
    <p
      className={cn(
        "aui-md-p my-2.5 leading-6 first:mt-0 last:mb-0",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLParagraphElement>)}
    />
  ),
  a: ({ className, ...props }: Record<string, unknown>) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className as string,
      )}
      {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
    />
  ),
  blockquote: ({ className, ...props }: Record<string, unknown>) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-2.5 border-s-2 ps-3 italic",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLQuoteElement>)}
    />
  ),
  ul: ({ className, ...props }: Record<string, unknown>) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-2 ms-4 list-disc [&>li]:mt-1",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLUListElement>)}
    />
  ),
  ol: ({ className, ...props }: Record<string, unknown>) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-2 ms-4 list-decimal [&>li]:mt-1",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLOListElement>)}
    />
  ),
  hr: ({ className, ...props }: Record<string, unknown>) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-2", className as string)}
      {...(props as React.HTMLAttributes<HTMLHRElement>)}
    />
  ),
  table: ({ className, ...props }: Record<string, unknown>) => (
    <table
      className={cn(
        "aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLTableElement>)}
    />
  ),
  th: ({ className, ...props }: Record<string, unknown>) => (
    <th
      className={cn(
        "aui-md-th bg-muted-foreground/8 px-2 py-1 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right dark:bg-muted-foreground/12",
        className as string,
      )}
      {...(props as React.ThHTMLAttributes<HTMLTableCellElement>)}
    />
  ),
  td: ({ className, ...props }: Record<string, unknown>) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-2 py-1 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className as string,
      )}
      {...(props as React.TdHTMLAttributes<HTMLTableCellElement>)}
    />
  ),
  tr: ({ className, ...props }: Record<string, unknown>) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLTableRowElement>)}
    />
  ),
  li: ({ className, ...props }: Record<string, unknown>) => (
    <li className={cn("aui-md-li leading-6", className as string)} {...(props as React.HTMLAttributes<HTMLLIElement>)} />
  ),
  sup: ({ className, ...props }: Record<string, unknown>) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className as string)}
      {...(props as React.HTMLAttributes<HTMLElement>)}
    />
  ),
  inlineCode: ({ className, ...props }: Record<string, unknown>) => (
    <code
      className={cn(
        "aui-md-inline-code border-border/50 bg-muted/50 rounded-md border px-1.5 py-0.5 font-mono text-[0.85em]",
        className as string,
      )}
      {...(props as React.HTMLAttributes<HTMLElement>)}
    />
  ),
} as StreamdownTextComponents;
