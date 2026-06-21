import {
  useMemo,
  useState,
  type FormEvent,
  type FormEventHandler,
} from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import type { AuthConfigResponse } from "@agework/shared/api";
import { AppLogo } from "@/components/app-logo";
import { AgeWorkWordmark } from "@/components/agework-wordmark";
import { LoginForm, type AuthMode } from "@/components/login-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authApi } from "@/api/auth";
import { queryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth-store";
import { usernameSchema, passwordSchema, validationMessage } from "@/utils/validation";

interface RequiredPasswordChangeFormProps {
  title: string;
  description: string;
  submitLabel: string;
  newPassword: string;
  confirmPassword: string;
  passwordError: string;
  confirmError: string;
  error: string;
  loading: boolean;
  canSubmit: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
}

function RequiredPasswordChangeForm({
  title,
  description,
  submitLabel,
  newPassword,
  confirmPassword,
  passwordError,
  confirmError,
  error,
  loading,
  canSubmit,
  onSubmit,
  onNewPasswordChange,
  onConfirmPasswordChange,
}: RequiredPasswordChangeFormProps) {
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={!!passwordError}>
              <FieldLabel htmlFor="new-password">新密码</FieldLabel>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => onNewPasswordChange(event.target.value)}
                autoComplete="new-password"
                aria-invalid={!!passwordError}
                required
              />
              {!passwordError && (
                <FieldDescription>至少 8 位，包含字母和数字。</FieldDescription>
              )}
              {passwordError && <FieldError>{passwordError}</FieldError>}
            </Field>
            <Field data-invalid={!!confirmError}>
              <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) =>
                  onConfirmPasswordChange(event.target.value)
                }
                autoComplete="new-password"
                aria-invalid={!!confirmError}
                required
              />
              {confirmError && <FieldError>{confirmError}</FieldError>}
            </Field>
            {error && (
              <FieldError className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2">
                {error}
              </FieldError>
            )}
            <Field>
              <Button
                type="submit"
                className="w-full"
                disabled={!canSubmit || loading}
              >
                {loading ? "保存中..." : submitLabel}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const setSetupRequired = useAuthStore((s) => s.setSetupRequired);
  const user = useAuthStore((s) => s.user);
  const appName = useAuthStore((s) => s.appName);
  const setupRequired = useAuthStore((s) => s.setupRequired);
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registrationSuccessOpen, setRegistrationSuccessOpen] = useState(false);
  const requiresPasswordChange = user?.mustChangePassword === true;

  const usernameError = useMemo(
    () => (username ? validationMessage(usernameSchema, username) : ""),
    [username],
  );
  const passwordError = useMemo(
    () =>
      mode === "register" && password
        ? validationMessage(passwordSchema, password)
        : "",
    [mode, password],
  );
  const canSubmit = Boolean(
    username.trim() &&
    password &&
    !usernameError &&
    (mode === "login" || !passwordError),
  );
  const newPasswordError = useMemo(
    () => (newPassword ? validationMessage(passwordSchema, newPassword) : ""),
    [newPassword],
  );
  const confirmPasswordError =
    confirmPassword && newPassword !== confirmPassword
      ? "两次输入的密码不一致"
      : "";
  const canChangePassword = Boolean(
    newPassword && confirmPassword && !newPasswordError && !confirmPasswordError,
  );

  function handleModeChange(nextMode: AuthMode) {
    setMode(nextMode);
    setError("");
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!canSubmit) return;

    setLoading(true);
    try {
      if (mode === "register") {
        await authApi.register({ username, password });
        setRegistrationSuccessOpen(true);
        setPassword("");
        setMode("login");
        return;
      }

      const { token, user } = await authApi.login({ username, password });
      setAuth(token, user);
      setPassword("");
      if (user.mustChangePassword) return;
      await router.navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleCompletePasswordChange(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!canChangePassword) return;

    setLoading(true);
    try {
      const { token, user } = await authApi.changePassword({ newPassword });
      setAuth(token, user);
      setNewPassword("");
      setConfirmPassword("");
      toast.success("修改密码成功");
      await router.navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改密码失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!canChangePassword) return;

    setLoading(true);
    try {
      const { token, user } = await authApi.setup({ newPassword });
      setAuth(token, user);
      setSetupRequired(false);
      queryClient.setQueryData<AuthConfigResponse>(
        ["auth", "config"],
        (config) =>
          config ? { ...config, setupRequired: false } : config,
      );
      setNewPassword("");
      setConfirmPassword("");
      toast.success("初始化完成");
      await router.navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2.5 self-center text-foreground">
          <AppLogo size={32} />
          <AgeWorkWordmark value={appName} size="lg" tone="solid" />
        </div>
        {setupRequired ? (
          <RequiredPasswordChangeForm
            title="初始化系统"
            description="设置 admin 管理员密码后开始使用"
            submitLabel="创建管理员并进入"
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            passwordError={newPasswordError}
            confirmError={confirmPasswordError}
            error={error}
            loading={loading}
            canSubmit={canChangePassword}
            onSubmit={handleSetup}
            onNewPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
        ) : requiresPasswordChange ? (
          <RequiredPasswordChangeForm
            title="修改密码"
            description="设置新的登录密码后继续使用系统"
            submitLabel="保存并继续"
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            passwordError={newPasswordError}
            confirmError={confirmPasswordError}
            error={error}
            loading={loading}
            canSubmit={canChangePassword}
            onSubmit={handleCompletePasswordChange}
            onNewPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
        ) : (
          <LoginForm
            mode={mode}
            username={username}
            password={password}
            usernameError={usernameError}
            passwordError={passwordError}
            error={error}
            loading={loading}
            canSubmit={canSubmit}
            registrationSuccessOpen={registrationSuccessOpen}
            onSubmit={handleSubmit}
            onModeChange={handleModeChange}
            onRegistrationSuccessOpenChange={setRegistrationSuccessOpen}
            onUsernameChange={setUsername}
            onPasswordChange={setPassword}
          />
        )}
      </div>
    </main>
  );
}
