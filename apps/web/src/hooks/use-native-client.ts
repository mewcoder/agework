import { useEffect, useState } from "react";

function detectNativeClient(): boolean {
  if (typeof window === "undefined") return false;
  return (
    !!window.agework ||
    window.navigator.userAgent.includes("AgeWorkDesktop/") ||
    window.document.documentElement.classList.contains("electron")
  );
}

export function useNativeClient(): boolean {
  const [nativeClient] = useState(detectNativeClient);

  useEffect(() => {
    if (nativeClient) {
      document.documentElement.classList.add("electron");
    }
  }, [nativeClient]);

  return nativeClient;
}
