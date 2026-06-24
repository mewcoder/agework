import { Module } from "@nestjs/common";
import { ModelProviderModule } from "../model-providers/model-provider.module";
import { ConversationController } from "./conversation.controller";
import { ConversationService } from "./conversation.service";
import { TitleService } from "./title.service";

@Module({
  imports: [ModelProviderModule],
  controllers: [ConversationController],
  providers: [ConversationService, TitleService],
  exports: [ConversationService, TitleService],
})
export class ConversationModule {}
