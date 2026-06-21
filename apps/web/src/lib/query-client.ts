import { MutationCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/utils/error";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s 内复用缓存，避免组件重挂载时重复请求
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _variables, _options, mutation) => {
      if (mutation.meta?.suppressGlobalError) return;
      toast.error(errorMessage(error, "请求失败，请稍后重试"));
    },
  }),
});
