import { type ComponentPropsWithRef, forwardRef } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type IconActionButtonProps = ComponentPropsWithRef<"button"> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const IconActionButton = forwardRef<
  HTMLButtonElement,
  IconActionButtonProps
>(({ children, tooltip, side = "bottom", className, ...rest }, ref) => {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button
          type="button"
          {...rest}
          className={cn(
            "flex size-5 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-35 [&>svg]:size-4 [&>svg]:text-current",
            className,
          )}
          ref={ref}
        >
          {children}
          <span className="sr-only">{tooltip}</span>
        </button>
      } />
      <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
});

IconActionButton.displayName = "IconActionButton";
