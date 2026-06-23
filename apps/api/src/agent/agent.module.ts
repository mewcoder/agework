import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentRunHandler } from "./agent-run-handler";
import { AgentSpecBuilder } from "./agent-spec.builder";
import { TitleService } from "./title.service";
import { ConversationModule } from "../conversations/conversation.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";

@Module({
  imports: [ConversationModule, RuntimeModule, ModelProviderModule],
  controllers: [AgentController],
  providers: [
    AgentRunHandler,
    AgentSpecBuilder,
    TitleService,
  ],
})
export class AgentModule {}
