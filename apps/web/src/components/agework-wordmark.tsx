import { cn } from "@/lib/utils";

type AgeWorkWordmarkSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<AgeWorkWordmarkSize, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-xl",
  xl: "text-3xl @md:text-4xl",
};

interface AgeWorkWordmarkProps {
  value?: string;
  size?: AgeWorkWordmarkSize;
  tone?: "split" | "solid";
  className?: string;
}

export function AgeWorkWordmark({
  value = "AgeWork",
  size = "md",
  tone = "split",
  className,
}: AgeWorkWordmarkProps) {
  if (value !== "AgeWork") {
    return (
      <span className={cn("agework-wordmark", SIZE_CLASS[size], className)}>
        {value}
      </span>
    );
  }

  return (
    <span className={cn("agework-wordmark", SIZE_CLASS[size], className)}>
      <span className="agework-wordmark-age">Age</span>
      <span
        className={cn(
          "agework-wordmark-work",
          tone === "solid" && "agework-wordmark-work-solid",
        )}
      >
        Work
      </span>
    </span>
  );
}
