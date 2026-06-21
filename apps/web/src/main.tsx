import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "@/styles/globals.css";
import "@/i18n";
import { queryClient } from "@/lib/query-client";
import { setUnauthorizedHandler } from "@/lib/http";
import { router } from "./router";

setUnauthorizedHandler(() => {
  router.navigate({ to: "/login" });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
