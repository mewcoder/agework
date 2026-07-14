import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { Roles } from "../../auth/decorators/roles.decorator";
import type { JwtUser } from "../../auth/auth.types";
import { RuntimeService } from "../runtime.service";
import { CreateRuntimeDto } from "../dto/create-runtime.dto";
import { UpdateEnvConfigOverrideDto } from "../dto/update-env-config-override.dto";
import { InstallCliDto } from "../dto/install-cli.dto";
import { RuntimeHostIdDto } from "../dto/runtime-host-id.dto";

/**
 * Runtime 管理后台:配对管理(create/delete)、列出全部 Runtime、CLI 状态查看、
 * envConfig 覆盖、触发重检。只调 RuntimeService 根 Service,不直接注入
 * repository / tunnel handler。
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

  /** 创建 registered Host 并生成配对 token（归属当前管理员）。 */
  @Post("create")
  create(@Body() body: CreateRuntimeDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.create(user.userId, body.name);
  }

  /** 注销 registered Host（软删除）。 */
  @Post("delete")
  delete(@Body() body: RuntimeHostIdDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.delete(user.userId, body.id);
  }

  /** 触发 runtime 重新检测本机 CLI 环境并上报。 */
  @Post("detect-env")
  async detectEnv(@Body() body: RuntimeHostIdDto) {
    return this.runtimeService.detectEnv(body.id);
  }

  /** 管理员覆盖 runtime 的 CLI 路径（per-agent）。 */
  @Post("update-env-config")
  async updateEnvConfigOverride(@Body() body: UpdateEnvConfigOverrideDto) {
    await this.runtimeService.updateEnvConfigOverride(
      body.id,
      body.agentType,
      body.executablePath
    );
    return { ok: true };
  }

  /** 管理员一键安装 runtime 的独立 CLI（仅 native runtimeType）。 */
  @Post("install-cli")
  async installCli(@Body() body: InstallCliDto) {
    return this.runtimeService.installCli(body.id, body.agentType);
  }
}
