import { apiGet } from '@/lib/http';
import type { AboutResponse } from '@agework/shared/api';

export type { AboutResponse };

export const systemApi = {
  about: () => apiGet<AboutResponse>('/api/v1/system/about'),
};