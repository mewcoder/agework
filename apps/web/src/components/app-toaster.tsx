import { Toaster } from "sonner";
import { useTheme } from "@/components/theme-provider";

export function AppToaster() {
  const { theme } = useTheme();

  return (
    <Toaster
      richColors
      position="top-right"
      theme={theme}
    />
  );
}
