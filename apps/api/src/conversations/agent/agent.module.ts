import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { ConversationModule } from "../conversation.module";
import { RunsModule } from "../../runs/runs.module";
import { ModelProviderModule } from "../../model-providers/model-provider.module";

@Module({
  imports: [ConversationModule, RunsModule, ModelProviderModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
