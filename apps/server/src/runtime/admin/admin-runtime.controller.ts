import { Body, Controller, Get, Post } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RuntimeService } from "../runtime.service";
import { UpdateEnvConfigOverrideDto } from "../dto/update-env-config-override.dto";

/**
 * Runtime 管理后台：列出全部 Runtime、CLI 状态查看、envConfig 覆盖、触发重检。
 * 只调 RuntimeService 根 Service，不直接注入 repository / tunnel handler。
 */
@Roles("admin")
@Controller("admin/runtimes")
export class AdminRuntimeController {
  constructor(private readonly runtimeService: RuntimeService) {}

  /** 列出全部 Runtime（builtin + 所有用户的 registered），不含已注销。 */
  @Get("list")
  listAll() {
    return this.runtimeService.listAll();
  }

  /** 触发 runtime 重新检测本机 CLI 环境并上报。 */
  @Post("detect-env")
  async detectEnv(@Body() body: { id: string }) {
    return this.runtimeService.detectEnv(body.id);
  }

  /** 管理员覆盖 runtime 的 CLI 路径（per-agent）。 */
  @Post("env-config")
  async updateEnvConfigOverride(@Body() body: UpdateEnvConfigOverrideDto) {
    await this.runtimeService.updateEnvConfigOverride(
      body.id,
      body.agentType,
      body.executablePath
    );
    return { ok: true };
  }
}
