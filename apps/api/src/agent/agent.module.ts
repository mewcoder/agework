import { Module } from "@nestjs/common";
import { ConversationModule } from "../conversation/conversation.module";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { RunModule } from "../run/run.module";
import { WorkspaceModule } from "../workspace/workspace.module";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";

/**
 * Agent interaction entrypoint module:用户跟 agent 打交道的入口流程
 * (create / run / resume / reply / stop / options)。只编排下层 module 导出的 Service,
 * 不持有数据,也不接管 run 生命周期 / runtime / model-provider 配置 ownership。
 */
@Module({
  imports: [ConversationModule, WorkspaceModule, ModelProviderModule, RunModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
