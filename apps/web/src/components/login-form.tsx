import type { FormEventHandler } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type AuthMode = "login" | "register"

interface LoginFormProps {
  mode: AuthMode
  username: string
  password: string
  usernameError: string
  passwordError: string
  error: string
  loading: boolean
  canSubmit: boolean
  registrationSuccessOpen: boolean
  className?: string
  onSubmit: FormEventHandler<HTMLFormElement>
  onModeChange: (mode: AuthMode) => void
  onRegistrationSuccessOpenChange: (open: boolean) => void
  onUsernameChange: (value: string) => void
  onPasswordChange: (value: string) => void
}

export function LoginForm({
  mode,
  username,
  password,
  usernameError,
  passwordError,
  error,
  loading,
  canSubmit,
  registrationSuccessOpen,
  className,
  onSubmit,
  onModeChange,
  onRegistrationSuccessOpenChange,
  onUsernameChange,
  onPasswordChange,
}: LoginFormProps) {
  const isLogin = mode === "login"

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            {isLogin ? "登录" : "注册"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field data-invalid={!!usernameError}>
                <FieldLabel htmlFor="username">用户名</FieldLabel>
                <Input
                  id="username"
                  value={username}
                  onChange={(event) => onUsernameChange(event.target.value)}
                  autoComplete="username"
                  aria-invalid={!!usernameError}
                  required
                />
                {usernameError && <FieldError>{usernameError}</FieldError>}
              </Field>
              <Field data-invalid={!!passwordError}>
                <FieldLabel htmlFor="password">密码</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  aria-invalid={!!passwordError}
                  required
                />
                {isLogin && (
                  <FieldDescription>
                    <AlertDialog>
                      <AlertDialogTrigger render={
                        <button
                          type="button"
                          className="underline-offset-4 hover:underline"
                        >
                          忘记密码？
                        </button>
                      } />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>忘记密码？</AlertDialogTitle>
                          <AlertDialogDescription>
                            请联系管理员重置密码。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogAction type="button">
                            确认
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </FieldDescription>
                )}
                {!isLogin && !passwordError && (
                  <FieldDescription>
                    至少 8 位，包含字母和数字。
                  </FieldDescription>
                )}
                {passwordError && <FieldError>{passwordError}</FieldError>}
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
                  {loading ? "处理中..." : isLogin ? "登录" : "注册"}
                </Button>
                <FieldDescription className="text-center">
                  {isLogin ? "没有账号？" : "已有账号？"}
                  <button
                    type="button"
                    className="ml-1 font-medium text-primary underline-offset-4 hover:underline"
                    onClick={() => onModeChange(isLogin ? "register" : "login")}
                  >
                    {isLogin ? "注册账号" : "返回登录"}
                  </button>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <AlertDialog
        open={registrationSuccessOpen}
        onOpenChange={onRegistrationSuccessOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>注册</AlertDialogTitle>
            <AlertDialogDescription>
              等待管理员审核。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction type="button">确认</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
