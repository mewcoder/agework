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
  const [nativeClient, setNativeClient] = useState(detectNativeClient);

  useEffect(() => {
    const detected = detectNativeClient();
    setNativeClient(detected);
    if (detected) {
      document.documentElement.classList.add("electron");
    }
  }, []);

  return nativeClient;
}
