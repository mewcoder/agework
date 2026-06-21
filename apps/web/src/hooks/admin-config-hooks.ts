import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminConfigApi } from '@/api/admin-config';

export type { SettingListItem, SettingSource } from '@/api/admin-config';

const queryKey = ['admin', 'config', 'list'];

export function useAdminSettings() {
  return useQuery({
    queryKey,
    queryFn: () => adminConfigApi.list(),
  });
}

export function useSetAdminSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => adminConfigApi.set(key, value),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
}

export function useResetAdminSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => adminConfigApi.reset(key),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
}
