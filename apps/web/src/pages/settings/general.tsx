import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import {
  SettingsItem,
  SettingsSection,
} from '@/components/settings/settings-section';
import { SettingsPageHeader } from '@/components/settings/settings-panel';
import { IconActionButton } from '@/components/icon-action-button';
import {
  type ThemeSkin,
  useTheme,
} from '@/components/theme-provider';
import { cn } from '@/lib/utils';

const themeOptions = [
  { value: 'light', label: '浅色', icon: SunIcon },
  { value: 'dark', label: '深色', icon: MoonIcon },
  { value: 'system', label: '系统', icon: MonitorIcon },
] as const;

const skinOptions = [
  { value: 'default', label: 'default' },
  { value: 'warm', label: 'warm' },
  { value: 'harbor', label: 'harbor' },
  { value: 'cobalt', label: 'cobalt' },
  { value: 'sunset', label: 'sunset' },
] as const;

export function GeneralSettings() {
  const { theme, skin, setTheme, setSkin } = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title="通用" description="设置应用的基础显示偏好" />

      <SettingsSection>
        <SettingsItem title="主题" description="选择浅色、深色，或跟随系统外观">
          <div className="flex items-center gap-1">
            {themeOptions.map((option) => {
              const Icon = option.icon;
              const selected = theme === option.value;

              return (
                <IconActionButton
                  key={option.value}
                  tooltip={option.label}
                  aria-pressed={selected}
                  onClick={() => setTheme(option.value)}
                  className={cn(
                    'size-8 rounded-full hover:bg-accent hover:text-accent-foreground',
                    selected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                </IconActionButton>
              );
            })}
          </div>
        </SettingsItem>
        <SettingsItem title="皮肤" description="切换工作台的视觉外观">
          <Select
            value={skin}
            onValueChange={(value) => setSkin(value as ThemeSkin)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {skinOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsItem>
      </SettingsSection>
    </div>
  );
}
