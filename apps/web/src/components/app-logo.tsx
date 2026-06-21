import { cn } from "@/lib/utils";
import logo from "@/assets/logo.png";

interface AppLogoProps {
  size?: number;
  className?: string;
}

export function AppLogo({ size = 28, className }: AppLogoProps) {
  return (
    <img
      src={logo}
      alt="logo"
      className={cn("shrink-0 object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}
