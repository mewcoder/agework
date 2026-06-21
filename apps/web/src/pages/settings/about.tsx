import { Badge } from '@/components/ui/badge';
import { AgentIcon } from '@/components/icons/agent';
import { useAboutInfo } from '@/hooks/use-about-info';
import {
  SettingsItem,
  SettingsSection,
} from '@/components/settings/settings-section';
import { SettingsPageHeader } from '@/components/settings/settings-panel';
import logoUrl from '@/assets/logo.png';

function cleanVersion(value: string) {
  return value.replace(/^[~^]/, '');
}

function aboutIcon(id: 'platform' | 'claude' | 'codex') {
  if (id === 'platform') {
    return <img src={logoUrl} alt="" className="size-4 shrink-0" />;
  }

  return <AgentIcon agent={id} size={16} />;
}

export function AboutSettings() {
  const { data: about, isLoading, isError } = useAboutInfo();
  const items = about
    ? [
        {
          id: 'platform' as const,
          name: about.platform.name,
          description: about.platform.description,
          version: about.platform.version,
        },
        ...about.agents,
      ]
    : [];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="关于"
        description="查看当前平台说明和核心 SDK 版本"
      />

      <SettingsSection>
        {isLoading ? (
          <SettingsItem title="加载中" description="正在读取平台信息">
            <Badge variant="outline">...</Badge>
          </SettingsItem>
        ) : isError ? (
          <SettingsItem title="加载失败" description="暂时无法读取平台信息">
            <Badge variant="destructive">错误</Badge>
          </SettingsItem>
        ) : (
          items.map((item) => (
            <SettingsItem
              key={item.id}
              title={
                <span className="flex items-center gap-2">
                  {aboutIcon(item.id)}
                  <span>{item.name}</span>
                </span>
              }
              description={'description' in item ? item.description : undefined}
            >
              <Badge variant="outline">{cleanVersion(item.version)}</Badge>
            </SettingsItem>
          ))
        )}
      </SettingsSection>
    </div>
  );
}
