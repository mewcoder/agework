import { Module } from "@nestjs/common";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { RunModule } from "../run/run.module";
import { WorkspaceModule } from "../workspace/workspace.module";
import { AgentService } from "./agent/agent.service";
import { ConversationController } from "./conversation.controller";
import { ConversationRepository } from "./conversation.repository";
import { ConversationRunBridge } from "./run/conversation-run.bridge";
import { ConversationService } from "./conversation.service";
import { TitleService } from "./title/title.service";

@Module({
  imports: [ModelProviderModule, RunModule, WorkspaceModule],
  controllers: [ConversationController],
  providers: [
    ConversationService,
    ConversationRepository,
    TitleService,
    AgentService,
    ConversationRunBridge,
  ],
  exports: [ConversationService],
})
export class ConversationModule {}
