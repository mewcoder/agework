import { Module } from "@nestjs/common";

import { RuntimeService } from "./runtime.service";

/**
 * Runtime 领域的组合根:只登记门面 Service。provider 装配(ConfigService → resolver)
 * 收在 RuntimeService 构造函数内,provider 实现与契约全在 `@agework/runtime` 包里。
 */
@Module({
  providers: [RuntimeService],
  exports: [RuntimeService],
})
export class RuntimeModule {}
