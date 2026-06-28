import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { usersApi, type PasswordIssueResponse } from "@/api/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/utils/error";
import { usernameSchema } from "@/utils/validation";

const createUserFormSchema = z.object({
  username: usernameSchema,
  role: z.enum(["user", "admin"]),
});

type CreateUserFormValues = z.infer<typeof createUserFormSchema>;

export function CreateUserDialogForm({
  canCreateAdmin,
  onCreated,
  onOpenChange,
}: {
  canCreateAdmin: boolean;
  onCreated: (result: PasswordIssueResponse) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createUser = useMutation({
    mutationFn: (values: CreateUserFormValues) =>
      usersApi.create({ username: values.username.trim(), role: values.role }),
  });

  const form = useForm<CreateUserFormValues>({
    resolver: zodResolver(createUserFormSchema),
    defaultValues: {
      username: "",
      role: "user",
    },
  });

  async function handleSubmit(values: CreateUserFormValues) {
    setSubmitError(null);

    try {
      const result = await createUser.mutateAsync(values);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
      onOpenChange(false);
      onCreated(result);
    } catch (error) {
      setSubmitError(errorMessage(error, "创建用户失败"));
    }
  }

  const usernameValue =
    useWatch({ control: form.control, name: "username" }) ?? "";
  const formId = "create-user-dialog-form";

  return (
    <>
      <form id={formId} onSubmit={form.handleSubmit(handleSubmit)}>
        <FieldGroup>
          <Controller
            name="username"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="create-user-username">用户名</FieldLabel>
                <Input
                  {...field}
                  id="create-user-username"
                  aria-invalid={fieldState.invalid}
                  placeholder="输入用户名"
                  autoFocus
                  autoComplete="off"
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <Controller
            name="role"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="create-user-role">角色</FieldLabel>
                <Select
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                >
                  <SelectTrigger id="create-user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="user">普通用户</SelectItem>
                      {canCreateAdmin && (
                        <SelectItem value="admin">管理员</SelectItem>
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldContent className="text-sm text-muted-foreground">
                  {canCreateAdmin
                    ? "超级管理员可创建普通管理员和普通用户。"
                    : "普通管理员只能创建普通用户。"}
                </FieldContent>
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          {submitError && <FieldError>{submitError}</FieldError>}
        </FieldGroup>
      </form>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          取消
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={!usernameValue.trim() || createUser.isPending}
        >
          创建
        </Button>
      </DialogFooter>
    </>
  );
}
