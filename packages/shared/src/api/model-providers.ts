import type { ListResponse } from "../common";

export type ModelProviderScope = "environment" | "global" | "user";

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  models: string[];
  extraConfig: Record<string, string>;
};

export type ModelProviderEnvironmentStatus = {
  command: string;
  commandAvailable: boolean;
  configAvailable: boolean;
};

export type ModelProviderResponse = {
  modelProviderId: string;
  agentType: string;
  scope: ModelProviderScope;
  userId: string | null;
  name: string;
  isEnabled: boolean;
  /** 序列化后的 provider 配置 JSON 字符串。 */
  providerConfig: string;
  environmentStatus?: ModelProviderEnvironmentStatus;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
};

export type CreateModelProviderRequest = {
  agentType: string;
  name: string;
  providerConfig: ProviderConfig;
};

export type UpdateModelProviderRequest = {
  id: string;
  name: string;
  providerConfig: ProviderConfig;
};

export type SetModelProviderEnabledRequest = {
  id: string;
  isEnabled: boolean;
};

export type ModelProviderIdRequest = { id: string };

export type ModelProviderTestResponse = {
  success: boolean;
  latency: number;
  error?: string;
};

export type SystemEnvVar = { name: string; isSet: boolean; preview: string };
export type SystemConfigFile = {
  path: string;
  exists: boolean;
  description: string;
};
export type ModelProviderSystemInfoResponse = {
  envVars: SystemEnvVar[];
  configFiles: SystemConfigFile[];
};

export type ModelProviderListResponse = ListResponse<ModelProviderResponse>;
