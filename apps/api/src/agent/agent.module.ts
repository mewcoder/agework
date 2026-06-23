import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { ConversationModule } from "../conversations/conversation.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";

@Module({
  imports: [ConversationModule, RuntimeModule, ModelProviderModule],
  controllers: [AgentController],
  providers: [AgentService, AgentSpecBuilder],
})
export class AgentModule {}
