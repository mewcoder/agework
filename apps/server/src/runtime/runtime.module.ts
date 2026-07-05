import { Module } from "@nestjs/common";

import { RuntimeService } from "./runtime.service";
import { LocalRuntime } from "./local/local-runtime";

/**
 * Runtime 领域的组合根:门面 Service + Managed 实现。`LocalRuntime` 是 internal
 * provider(不 export,上层经 `RuntimeService.runtimeFor()` 拿 `Runtime` 接口);
 * provider 装配(ConfigService → resolver)收在 `LocalRuntime` 构造函数内,
 * provider 实现与契约全在 `@agework/providers` 包里。
 */
@Module({
  providers: [RuntimeService, LocalRuntime],
  exports: [RuntimeService],
})
export class RuntimeModule {}
