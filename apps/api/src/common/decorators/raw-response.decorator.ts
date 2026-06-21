import { SetMetadata } from "@nestjs/common";

export const RAW_RESPONSE_KEY = "rawResponse";

/**
 * 标记控制器/路由跳过 ResponseInterceptor 的 {code,data,message} 包装。
 * 用于 worker 回连的 internal runtime API —— 它和前端约定的是另一套协议格式。
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
