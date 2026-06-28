import { Module } from "@nestjs/common";
import { ModelProviderModule } from "../model-provider/model-provider.module";
import { ConversationController } from "./conversation.controller";
import { ConversationService } from "./conversation.service";
import { ConversationRepository } from "./conversation.repository";
import { TitleService } from "./title/title.service";

@Module({
  imports: [ModelProviderModule],
  controllers: [ConversationController],
  providers: [ConversationService, ConversationRepository, TitleService],
  exports: [ConversationService],
})
export class ConversationModule {}
