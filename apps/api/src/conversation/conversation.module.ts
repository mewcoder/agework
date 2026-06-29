import { Module } from "@nestjs/common";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { ConversationController } from "./conversation.controller";
import { ConversationRepository } from "./conversation.repository";
import { ConversationService } from "./conversation.service";
import { TitleService } from "./title/title.service";

@Module({
  imports: [ModelProviderModule],
  controllers: [ConversationController],
  providers: [ConversationService, ConversationRepository, TitleService],
  exports: [ConversationService],
})
export class ConversationModule {}
