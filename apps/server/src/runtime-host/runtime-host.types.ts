/** 同一个 Host 路由适配器按角色暴露，消费者不能越面调用。 */
export const RUNTIME_HOST_EXECUTION = Symbol("RuntimeHostExecution");
export const RUNTIME_HOST_OPERATIONS = Symbol("RuntimeHostOperations");
export const RUNTIME_HOST_DIAGNOSTICS = Symbol("RuntimeHostDiagnostics");
