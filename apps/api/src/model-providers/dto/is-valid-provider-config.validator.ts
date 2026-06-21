import {
  registerDecorator,
  type ValidationOptions,
} from "class-validator";

/** 校验字段是统一的 ProviderConfig 结构：baseUrl/apiKey 必填非空 string，
 * models 必填非空 string[]，extraConfig 是 string 值的 record（可以是空对象，但必须存在）。 */
export function IsValidProviderConfig(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isValidProviderConfig",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return false;
          }
          const v = value as Record<string, unknown>;
          if (typeof v.baseUrl !== "string" || !v.baseUrl.trim()) return false;
          if (typeof v.apiKey !== "string" || !v.apiKey.trim()) return false;
          if (
            !Array.isArray(v.models) ||
            v.models.length === 0 ||
            !v.models.every((m) => typeof m === "string" && m.trim().length > 0)
          ) {
            return false;
          }
          if (
            typeof v.extraConfig !== "object" ||
            v.extraConfig === null ||
            Array.isArray(v.extraConfig) ||
            !Object.values(v.extraConfig).every((val) => typeof val === "string")
          ) {
            return false;
          }
          return true;
        },
        defaultMessage() {
          return `${propertyName} must be a valid provider config (baseUrl, apiKey, models[], extraConfig)`;
        },
      },
    });
  };
}
