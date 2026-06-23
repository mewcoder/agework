import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { ConversationModule } from "../conversation.module";
import { RuntimeModule } from "../../runtime/runtime.module";
import { ModelProviderModule } from "../../model-providers/model-provider.module";

@Module({
  imports: [ConversationModule, RuntimeModule, ModelProviderModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
