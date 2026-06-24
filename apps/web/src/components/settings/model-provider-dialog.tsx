import { useState, type CSSProperties } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useWatch } from "react-hook-form";
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { FormDialog } from "@/components/form-dialog";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentIcon } from "@/components/icons/agent";
import type { ModelProvider, ProviderConfigValues } from "@/hooks/model-provider-hooks";
import { useAgentOptions } from "@/hooks/use-agent-options";
import { errorMessage } from "@/utils/error";
import { type ManagedAgent, isManagedAgent, agentOrDefault } from "@/utils/model-provider";
import { AGENT_LABELS } from "@agework/shared";
import {
  type ModelProviderDialogFormValues,
  MODEL_CONFIG_NAME_MAX_LENGTH,
  NO_AUTOFILL_PROPS,
  modelProviderDialogFormSchema,
  initialFormValues,
  buildProviderConfig,
} from "./model-provider-form";

function HiddenInput({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  placeholder?: string;
  invalid: boolean;
}) {
  const [show, setShow] = useState(false);
  const hiddenStyle = {
    WebkitTextSecurity: show ? "none" : "disc",
  } as CSSProperties;

  return (
    <div className="relative flex items-center">
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-invalid={invalid}
        spellCheck={false}
        style={hiddenStyle}
        {...NO_AUTOFILL_PROPS}
        className="pr-8 font-mono text-sm"
      />
      <button
        type="button"
        onClick={() => setShow((current) => !current)}
        className="absolute right-2 text-muted-foreground hover:text-foreground"
        aria-label={show ? "隐藏密钥" : "显示密钥"}
      >
        {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: string;
  modelProvider?: ModelProvider;
  onSave: (
    name: string,
    providerConfig: ProviderConfigValues,
    agent: ManagedAgent,
  ) => Promise<void>;
  isSaving?: boolean;
  allowAgentSelect?: boolean;
};

type ModelProviderDialogFormProps = Omit<Props, "open" | "agent"> & {
  agent: ManagedAgent;
};

function ModelProviderDialogForm({
  onOpenChange,
  agent,
  modelProvider,
  onSave,
  isSaving,
  allowAgentSelect,
}: ModelProviderDialogFormProps) {
  const isEdit = !!modelProvider;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { data: agentOptions } = useAgentOptions();
  const form = useForm<ModelProviderDialogFormValues>({
    resolver: zodResolver(modelProviderDialogFormSchema),
    defaultValues: initialFormValues(modelProvider, agent),
  });

  async function handleSubmit(values: ModelProviderDialogFormValues) {
    const name = values.name.trim();
    setSubmitError(null);

    try {
      await onSave(name, buildProviderConfig(values), values.agent);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(errorMessage(error, "保存配置失败"));
    }
  }

  function addCustom() {
    const current = form.getValues("custom");
    form.setValue("custom", [...current, { key: "", value: "" }], {
      shouldDirty: true,
    });
  }

  function removeCustom(index: number) {
    const current = form.getValues("custom");
    form.setValue(
      "custom",
      current.filter((_, itemIndex) => itemIndex !== index),
      { shouldDirty: true, shouldValidate: true },
    );
  }

  function addModel() {
    const current = form.getValues("models");
    form.setValue("models", [...current, ""], { shouldDirty: true });
  }

  function removeModel(index: number) {
    const current = form.getValues("models");
    form.setValue(
      "models",
      current.filter((_, i) => i !== index),
      { shouldDirty: true, shouldValidate: true },
    );
  }

  const nameValue = useWatch({ control: form.control, name: "name" }) ?? "";
  const customFields = useWatch({ control: form.control, name: "custom" }) ?? [];
  const modelFields = useWatch({ control: form.control, name: "models" }) ?? [];
  const baseUrlValue = useWatch({ control: form.control, name: "baseUrl" }) ?? "";
  const apiKeyValue = useWatch({ control: form.control, name: "apiKey" }) ?? "";
  const formId = `model-provider-dialog-form-${modelProvider?.modelProviderId ?? "new"}`;
  const showAgentSelect = allowAgentSelect && !isEdit;
  const agents = agentOptions?.agents ?? [
    { id: agent, label: AGENT_LABELS[agent] },
  ];
  const hasRequiredFields =
    !!baseUrlValue.trim() && !!apiKeyValue.trim() && modelFields.some((m) => m?.trim());

  return (
    <>
      <form
        id={formId}
        onSubmit={form.handleSubmit(handleSubmit)}
        {...NO_AUTOFILL_PROPS}
      >
        <FieldGroup>
          {showAgentSelect && (
            <Controller
              name="agent"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel>Agent 类型</FieldLabel>
                  <ToggleGroup
                    variant="segment"
                    spacing={0}
                    value={field.value ? [field.value] : []}
                    onValueChange={(value) => {
                      const next = value[0];
                      if (!next || !isManagedAgent(next)) return;
                      field.onChange(next);
                    }}
                    className="grid w-full"
                    style={{
                      gridTemplateColumns: `repeat(${agents.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {agents.map((option) => (
                      <ToggleGroupItem
                        key={option.id}
                        value={option.id}
                        className="w-full"
                      >
                        <AgentIcon agent={option.id} />
                        {option.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <FieldDescription>
                    选择后会显示对应 Agent 的连接参数
                  </FieldDescription>
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          )}

          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="model-provider-label">名称</FieldLabel>
                <Input
                  ref={field.ref}
                  id="model-provider-label"
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  maxLength={MODEL_CONFIG_NAME_MAX_LENGTH}
                  placeholder="配置名称"
                  {...NO_AUTOFILL_PROPS}
                  autoFocus
                />
                <FieldDescription>
                  {nameValue.length}/{MODEL_CONFIG_NAME_MAX_LENGTH}
                </FieldDescription>
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <Controller
            name="baseUrl"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="model-provider-base-url">Base URL</FieldLabel>
                <Input
                  ref={field.ref}
                  id="model-provider-base-url"
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  aria-invalid={fieldState.invalid}
                  placeholder="https://api.anthropic.com"
                  spellCheck={false}
                  {...NO_AUTOFILL_PROPS}
                  className="font-mono text-sm"
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            name="apiKey"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="model-provider-api-key">API Key</FieldLabel>
                <HiddenInput
                  id="model-provider-api-key"
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  placeholder="sk-..."
                  invalid={fieldState.invalid}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          {modelFields.map((_, index) => (
            <Controller
              key={index}
              name={`models.${index}`}
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={`model-provider-model-${index}`}>
                    {index === 0 ? "模型" : `模型 ${index + 1}`}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      ref={field.ref}
                      id={`model-provider-model-${index}`}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      aria-invalid={fieldState.invalid}
                      placeholder="claude-opus-4-8"
                      spellCheck={false}
                      {...NO_AUTOFILL_PROPS}
                      className="font-mono text-sm"
                    />
                    {modelFields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        onClick={() => removeModel(index)}
                        aria-label="移除模型"
                      >
                        <Trash2Icon />
                      </Button>
                    )}
                  </div>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addModel} className="w-full">
            <PlusIcon data-icon="inline-start" />
            添加模型
          </Button>

          {customFields.map((_, index) => (
            <div key={index} className="flex gap-2">
              <Controller
                name={`custom.${index}.key`}
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel
                      htmlFor={`model-provider-extra-key-${index}`}
                      className="sr-only"
                    >
                      自定义字段名
                    </FieldLabel>
                    <Input
                      ref={field.ref}
                      id={`model-provider-extra-key-${index}`}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      aria-invalid={fieldState.invalid}
                      placeholder="key"
                      spellCheck={false}
                      {...NO_AUTOFILL_PROPS}
                      className="font-mono text-sm"
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
              <Controller
                name={`custom.${index}.value`}
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel
                      htmlFor={`model-provider-extra-value-${index}`}
                      className="sr-only"
                    >
                      自定义字段值
                    </FieldLabel>
                    <Input
                      ref={field.ref}
                      id={`model-provider-extra-value-${index}`}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      aria-invalid={fieldState.invalid}
                      placeholder="value"
                      spellCheck={false}
                      {...NO_AUTOFILL_PROPS}
                      className="font-mono text-sm"
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => removeCustom(index)}
                aria-label="移除自定义字段"
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addCustom}
            className="w-full"
          >
            <PlusIcon data-icon="inline-start" />
            添加自定义字段
          </Button>

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
          disabled={!nameValue.trim() || !hasRequiredFields || isSaving}
        >
          {isSaving ? "保存中..." : "保存"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ModelProviderDialog({
  open,
  onOpenChange,
  agent,
  modelProvider,
  onSave,
  isSaving,
  allowAgentSelect = false,
}: Props) {
  const resolvedAgent = agentOrDefault(modelProvider?.agentType ?? agent);
  const isEdit = !!modelProvider;
  const formKey = `${resolvedAgent}:${modelProvider?.modelProviderId ?? "new"}:${modelProvider?.updatedAt ?? ""}`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "编辑模型服务" : "新建模型服务"}
      description={isEdit
        ? "更新模型服务的连接参数"
        : "创建 Claude 或 Codex 的全局模型服务"}
      footer="none"
    >
      {open && (
        <ModelProviderDialogForm
          key={formKey}
          onOpenChange={onOpenChange}
          agent={resolvedAgent}
          modelProvider={modelProvider}
          onSave={onSave}
          isSaving={isSaving}
          allowAgentSelect={allowAgentSelect}
        />
      )}
    </FormDialog>
  );
}
