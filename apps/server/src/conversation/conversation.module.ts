import { Module } from "@nestjs/common";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { ConversationController } from "./conversation.controller";
import { ConversationRepository } from "./conversation.repository";
import { ConversationService } from "./conversation.service";
import { TitleGenerator } from "./title/title-generator";

@Module({
  imports: [ModelProviderModule],
  controllers: [ConversationController],
  providers: [ConversationService, ConversationRepository, TitleGenerator],
  exports: [ConversationService],
})
export class ConversationModule {}
