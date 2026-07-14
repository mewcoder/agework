/**
 * `RuntimeHostContract`（@agework/shared/protocol）的注入 token。
 * run 模块经它注入契约接口，看不见实现类——由本模块的
 * RuntimeHostAdapter 兑现（目标架构 §7 Phase 1）。
 */
export const RUNTIME_HOST_CONTRACT = Symbol("RuntimeHostContract");
