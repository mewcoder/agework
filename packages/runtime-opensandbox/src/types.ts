/** OpenSandbox SDK 连接参数；只属于可选 runtime 插件，不进入核心 provider 配置。 */
export type OpenSandboxConnectionConfig = {
  domain: string;
  protocol: "http" | "https";
  apiKey?: string;
  useServerProxy: boolean;
};
