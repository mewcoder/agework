import { useQuery } from '@tanstack/react-query';
import { systemApi } from '@/api/system';

export function useAboutInfo() {
  return useQuery({
    queryKey: ['system', 'about'],
    queryFn: systemApi.about,
  });
}
