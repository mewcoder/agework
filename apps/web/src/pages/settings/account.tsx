import { useMemo, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { authApi } from '@/api/auth';
import { roleLabel } from '@/utils/auth';
import { passwordSchema, validationMessage } from '@/utils/validation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  SettingsItem,
  SettingsSection,
} from '@/components/settings/settings-section';
import { SettingsPageHeader } from '@/components/settings/settings-panel';
import { useAuthStore } from '@/stores/auth-store';

export function AccountSettings() {
  const { user, logout, authRequired, setAuth } = useAuthStore();
  const router = useRouter();
  const isDevAuthDisabled = !authRequired;
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  const passwordError = useMemo(
    () => (newPassword ? validationMessage(passwordSchema, newPassword) : ''),
    [newPassword],
  );
  const confirmError =
    confirmPassword && newPassword !== confirmPassword ? '两次输入的密码不一致' : '';
  const canChangePassword =
    currentPassword && newPassword && confirmPassword && !passwordError && !confirmError;

  async function handleLogout() {
    try {
      await authApi.logout();
    } catch {
      // best-effort
    }
    logout();
    router.navigate({ to: '/login' });
  }

  function resetPasswordForm() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  }

  function handleChangePasswordOpenChange(open: boolean) {
    if (loading && !open) return;
    setChangePasswordOpen(open);
    if (!open) resetPasswordForm();
  }

  async function handleChangePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canChangePassword) return;

    setError('');
    setLoading(true);
    try {
      const shouldRedirect = Boolean(user?.mustChangePassword);
      const { token, user: nextUser } = await authApi.changePassword({
        currentPassword,
        newPassword,
      });
      setAuth(token, nextUser);
      resetPasswordForm();
      setChangePasswordOpen(false);
      toast.success('修改密码成功');
      if (shouldRedirect) await router.navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="账号"
        description={
          isDevAuthDisabled
            ? '开发免登录已开启，当前自动使用 admin 超级管理员'
            : user?.mustChangePassword
              ? '当前密码为临时密码，修改后才能继续使用系统'
              : '查看当前登录账号和基础账号状态'
        }
      />

      <SettingsSection>
        <SettingsItem title="用户名" description="当前登录账号">
          <div className="flex flex-col items-end gap-1">
            <span className="text-sm font-medium">
              {user?.username ?? '用户'}
            </span>
            <Badge variant={user?.role === 'super_admin' ? 'default' : 'secondary'}>
              {roleLabel(user?.role)}
            </Badge>
          </div>
        </SettingsItem>
        <SettingsItem
          title="密码状态"
          description={
            isDevAuthDisabled
              ? '当前请求会自动使用数据库中的 admin 账号'
              : user?.mustChangePassword
              ? '必须修改临时或初始密码'
              : '当前密码可正常使用'
          }
        >
          <Badge variant={user?.mustChangePassword ? 'destructive' : 'outline'}>
            {isDevAuthDisabled ? '免登录' : user?.mustChangePassword ? '需改密' : '正常'}
          </Badge>
        </SettingsItem>
      </SettingsSection>

      {!isDevAuthDisabled && (
        <SettingsSection>
          <SettingsItem
            title="修改密码"
            description={
              user?.mustChangePassword
                ? '修改当前临时或初始密码后才能继续使用系统'
                : '更新当前账号登录密码'
            }
          >
            <Dialog
              open={changePasswordOpen}
              onOpenChange={handleChangePasswordOpenChange}
            >
              <DialogTrigger render={<Button size="sm" />}>
                修改密码
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>修改密码</DialogTitle>
                  <DialogDescription>
                    输入当前密码，并设置新的登录密码。
                  </DialogDescription>
                </DialogHeader>
                <form id="change-password-form" onSubmit={handleChangePassword}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="current-password">
                        当前密码
                      </FieldLabel>
                      <Input
                        id="current-password"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        autoComplete="current-password"
                      />
                    </Field>
                    <Field data-invalid={!!passwordError}>
                      <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                      <Input
                        id="new-password"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        autoComplete="new-password"
                        aria-invalid={!!passwordError}
                      />
                      {!passwordError && (
                        <FieldDescription>
                          至少 8 位，包含字母和数字。
                        </FieldDescription>
                      )}
                      {passwordError && <FieldError>{passwordError}</FieldError>}
                    </Field>
                    <Field data-invalid={!!confirmError}>
                      <FieldLabel htmlFor="confirm-password">
                        确认新密码
                      </FieldLabel>
                      <Input
                        id="confirm-password"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        autoComplete="new-password"
                        aria-invalid={!!confirmError}
                      />
                      {confirmError && <FieldError>{confirmError}</FieldError>}
                    </Field>
                    {error && <FieldError>{error}</FieldError>}
                  </FieldGroup>
                </form>
                <DialogFooter>
                  <DialogClose
                    render={
                      <Button type="button" variant="outline" disabled={loading} />
                    }
                  >
                    取消
                  </DialogClose>
                  <Button
                    type="submit"
                    form="change-password-form"
                    disabled={!canChangePassword || loading}
                  >
                    {loading ? '保存中...' : '保存'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </SettingsItem>
        </SettingsSection>
      )}

      <SettingsSection>
        <SettingsItem
          title="退出登录"
          description={
            authRequired
              ? '退出当前账号并返回登录页'
              : '开发免登录开启时无需退出'
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={!authRequired}
            onClick={handleLogout}
          >
            退出
          </Button>
        </SettingsItem>
      </SettingsSection>
    </div>
  );
}
