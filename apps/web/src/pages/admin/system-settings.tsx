import { useState, useRef } from 'react';
import { Check, Loader2, Pencil, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import {
  SettingsItem,
  SettingsSection,
} from '@/components/settings/settings-section';
import {
  useAdminSettings,
  useResetAdminSetting,
  useSetAdminSetting,
  type SettingListItem,
} from '@/hooks/admin-config-hooks';

function SettingRow({ item }: { item: SettingListItem }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setMutation = useSetAdminSetting();
  const resetMutation = useResetAdminSetting();

  function startEdit() {
    setDraft(item.value ?? '');
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleCancel() {
    setEditing(false);
  }

  async function handleSave() {
    await setMutation.mutateAsync({ key: item.key, value: draft });
    setEditing(false);
    toast.success('参数已保存', { position: 'top-center' });
  }

  async function handleReset() {
    await resetMutation.mutateAsync(item.key);
    setEditing(false);
    setConfirmResetOpen(false);
  }

  const isPending = setMutation.isPending || resetMutation.isPending;
  const displayValue = item.value ?? '—';

  return (
    <SettingsItem
      title={item.label}
      description={item.description}
    >
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            type={item.type === 'number' ? 'number' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-48"
            disabled={isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') handleCancel();
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={handleSave}
            disabled={isPending}
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground"
            onClick={handleCancel}
            disabled={isPending}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center rounded-md bg-muted/50 px-3 py-1.5 text-sm font-mono tabular-nums w-48">
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              displayValue
            )}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={startEdit}
            disabled={isPending}
            title="编辑"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => setConfirmResetOpen(true)}
            disabled={isPending}
            title="重置为默认值"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <ConfirmDeleteDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        onConfirm={handleReset}
        isPending={resetMutation.isPending}
        title="重置该参数？"
        description={`确认将「${item.label}」重置为默认值？`}
        confirmLabel="重置"
        pendingLabel="重置中..."
      />
    </SettingsItem>
  );
}

export function SystemSettingsPanel({ showHeader = true }: { showHeader?: boolean }) {
  const { data, isLoading } = useAdminSettings();

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">系统参数设置</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理可在线调整的运行时配置</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">暂无数据</p>
      ) : (
        <SettingsSection>
          {data.map((item) => (
            <SettingRow key={item.key} item={item} />
          ))}
        </SettingsSection>
      )}
    </div>
  );
}
