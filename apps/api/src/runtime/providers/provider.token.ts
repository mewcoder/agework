/**
 * DI token：聚合所有已注册的 RuntimeProvider 实现。
 * 新增 provider 时，只需新建一个实现类并加入 runtime.module.ts
 * 的 providers 数组与本 token 的 inject 列表，registry 不再需要改动。
 */
export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
