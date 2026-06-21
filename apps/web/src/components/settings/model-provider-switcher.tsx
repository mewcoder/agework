import { ChevronsUpDown, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModelProviders } from '@/hooks/model-provider-hooks';
import { useSelectionStore, type AgentType } from '@/stores/selection-store';

type Props = {
  agent: AgentType;
};

export function ModelProviderSwitcher({ agent }: Props) {
  const { data: modelProviders = [] } = useModelProviders(agent);
  const selectedModelProviderId = useSelectionStore((state) => state.selectedModelProviderIds[agent]);
  const selectModelProvider = useSelectionStore((state) => state.selectModelProvider);
  const router = useRouter();

  const active = modelProviders.find((p) => p.modelProviderId === selectedModelProviderId) ?? modelProviders[0];
  const label = active?.name ?? '未配置模型';

  useEffect(() => {
    const hasSelectedModelProvider =
      selectedModelProviderId !== undefined &&
      modelProviders.some((p) => p.modelProviderId === selectedModelProviderId);
    if (hasSelectedModelProvider) return;
    if (!active?.modelProviderId && selectedModelProviderId === undefined) return;
    selectModelProvider(agent, active?.modelProviderId);
  }, [active?.modelProviderId, agent, modelProviders, selectModelProvider, selectedModelProviderId]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
          <span className="max-w-24 truncate">{label}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0" />
        </Button>
      } />

      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground capitalize">
            {agent} 模型服务
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {modelProviders.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无模型服务</div>
          ) : (
            <DropdownMenuRadioGroup
              value={active?.modelProviderId ?? ''}
              onValueChange={(modelProviderId) => selectModelProvider(agent, modelProviderId)}
            >
              {modelProviders.map((p) => (
                <DropdownMenuRadioItem key={p.modelProviderId} value={p.modelProviderId} className="text-sm">
                  {p.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs text-muted-foreground"
          onClick={() => router.navigate({ to: '/settings' })}
        >
          <Settings className="h-3 w-3" />
          管理模型服务...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
