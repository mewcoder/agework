import { apiGet, apiPost } from '@/lib/http';

export type SettingSource = 'db' | 'env' | 'default';

export interface SettingListItem {
  key: string;
  type: 'string' | 'number';
  label: string;
  description: string;
  value: string | undefined;
  source: SettingSource;
}

export const adminConfigApi = {
  list: () => apiGet<SettingListItem[]>('/api/v1/admin/config/list'),
  set: (key: string, value: string) =>
    apiPost<void>('/api/v1/admin/config/set', { key, value }),
  reset: (key: string) => apiPost<void>('/api/v1/admin/config/reset', { key }),
};
