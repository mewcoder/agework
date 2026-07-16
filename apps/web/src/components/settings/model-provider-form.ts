import { z } from "zod";
import type { ProviderConfigValues } from "@/hooks/model-provider-hooks";
import {
  AGENT_NATIVE_API_FORMAT,
  API_FORMATS,
  isApiFormat,
  type AgentType,
} from "@agework/shared";

// ── Constants ──────────────────────────────────────────────────────────────

export const MODEL_CONFIG_NAME_MAX_LENGTH = 50;

export const NO_AUTOFILL_PROPS = {
  autoComplete: "off",
  "data-lpignore": "true",
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

export type CustomField = { key: string; value: string };

// ── Schema ─────────────────────────────────────────────────────────────────

export const modelProviderDialogFormSchema = z
  .object({
    apiFormat: z.enum(API_FORMATS),
    name: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "请输入名称",
      })
      .refine((value) => value.trim().length <= MODEL_CONFIG_NAME_MAX_LENGTH, {
        message: `名称最多 ${MODEL_CONFIG_NAME_MAX_LENGTH} 个字`,
      }),
    baseUrl: z.string().refine((value) => value.trim().length > 0, {
      message: "请输入 Base URL",
    }),
    apiKey: z.string().refine((value) => value.trim().length > 0, {
      message: "请输入 API Key",
    }),
    models: z.array(z.string()),
    custom: z.array(
      z.object({
        key: z.string(),
        value: z.string(),
      }),
    ),
  })
  .superRefine((values, ctx) => {
    if (values.models.length === 0) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "请至少添加一个模型" });
    }
    values.models.forEach((model, index) => {
      if (!model.trim()) {
        ctx.addIssue({ code: "custom", path: ["models", index], message: "请输入模型名称" });
      }
    });

    const seen = new Set<string>();
    values.custom.forEach((field, index) => {
      const key = field.key.trim();
      const value = field.value.trim();
      if (!key && !value) return;

      if (!key) {
        ctx.addIssue({ code: "custom", path: ["custom", index, "key"], message: "请输入字段名" });
        return;
      }
      if (!value) {
        ctx.addIssue({ code: "custom", path: ["custom", index, "value"], message: "请输入字段值" });
      }
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["custom", index, "key"], message: "字段名不能重复" });
      }
      seen.add(key);
    });
  });

export type ModelProviderDialogFormValues = z.infer<typeof modelProviderDialogFormSchema>;

// ── Form data transformers ─────────────────────────────────────────────────

function parseProviderConfig(providerConfig: string): {
  baseUrl: string;
  apiKey: string;
  models: string[];
  custom: CustomField[];
} {
  try {
    const parsed = JSON.parse(providerConfig) as Partial<ProviderConfigValues>;
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((m): m is string => typeof m === "string")
      : [];
    const extraConfig =
      typeof parsed.extraConfig === "object" && parsed.extraConfig !== null
        ? (parsed.extraConfig as Record<string, string>)
        : {};
    const custom = Object.entries(extraConfig).map(([key, value]) => ({
      key,
      value: String(value),
    }));
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      models,
      custom,
    };
  } catch {
    return { baseUrl: "", apiKey: "", models: [], custom: [] };
  }
}

export function initialFormValues(
  modelProvider: import("@/hooks/model-provider-hooks").ModelProvider | undefined,
  defaultAgent?: AgentType,
): ModelProviderDialogFormValues {
  if (!modelProvider) {
    // 从某个 agent 的上下文进入时,默认它的原生格式。
    return {
      apiFormat: defaultAgent
        ? AGENT_NATIVE_API_FORMAT[defaultAgent]
        : "anthropic",
      name: "",
      baseUrl: "",
      apiKey: "",
      models: [""],
      custom: [],
    };
  }

  const parsed = parseProviderConfig(modelProvider.providerConfig);
  return {
    apiFormat: isApiFormat(modelProvider.apiFormat)
      ? modelProvider.apiFormat
      : "anthropic",
    name: modelProvider.name,
    baseUrl: parsed.baseUrl,
    apiKey: parsed.apiKey,
    models: parsed.models.length > 0 ? parsed.models : [""],
    custom: parsed.custom,
  };
}

export function buildProviderConfig(values: ModelProviderDialogFormValues): ProviderConfigValues {
  const extraConfig: Record<string, string> = {};
  for (const field of values.custom) {
    const key = field.key.trim();
    const value = field.value.trim();
    if (key && value) extraConfig[key] = value;
  }

  return {
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey.trim(),
    models: values.models.map((m) => m.trim()).filter(Boolean),
    extraConfig,
  };
}
