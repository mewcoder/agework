import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "用户名至少需要 3 个字符")
  .max(32, "用户名不能超过 32 个字符")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "用户名只能包含字母、数字、下划线和短横线，并以字母或数字开头",
  );

export const passwordSchema = z
  .string()
  .min(8, "密码至少需要 8 个字符")
  .max(128, "密码不能超过 128 个字符")
  .refine((value) => !/\s/.test(value), "密码不能包含空白字符")
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: "密码需要同时包含字母和数字",
  });

export function validationMessage(schema: z.ZodType<string>, value: string) {
  const parsed = schema.safeParse(value);
  return parsed.success ? "" : parsed.error.issues[0]?.message ?? "";
}
