import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { ConversationModule } from "../conversation.module";
import { RunModule } from "../../run/run.module";
import { ModelProviderModule } from "../../model-provider/model-provider.module";
import { WorkspaceModule } from "../../workspace/workspace.module";

@Module({
  imports: [ConversationModule, RunModule, ModelProviderModule, WorkspaceModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
