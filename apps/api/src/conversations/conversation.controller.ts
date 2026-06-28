import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/decorators/current-user.decorator";
import { ConversationService } from "./conversation.service";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { UpdateConversationDto } from "./dto/update-conversation.dto";
import { ConversationIdDto } from "./dto/conversation-id.dto";
import { ConversationListQueryDto } from "./dto/conversation-list-query.dto";
import { ConversationStatusQueryDto } from "./dto/conversation-status-query.dto";
import { ConversationSearchQueryDto } from "./dto/conversation-search-query.dto";

@Controller("conversations")
export class ConversationController {
  constructor(private conversationService: ConversationService) {}

  @Get("list")
  list(@CurrentUser() user: JwtUser, @Query() query: ConversationListQueryDto) {
    return this.conversationService.list(
      user.userId,
      query.after,
      query.status,
      query.sort
    );
  }

  @Get("search")
  search(
    @CurrentUser() user: JwtUser,
    @Query() query: ConversationSearchQueryDto
  ) {
    return this.conversationService.search(
      user.userId,
      query.q,
      query.limit ?? 20
    );
  }

  @Post("create")
  create(@Body() body: CreateConversationDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.create(
      user.userId,
      body.workspaceId,
      body.firstMessage,
      body.agentType,
      body.title
    );
  }

  @Get("query")
  findOne(@Query() query: ConversationIdDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.findOne(user.userId, query.id);
  }

  @Post("statuses/query")
  queryStatuses(
    @Body() body: ConversationStatusQueryDto,
    @CurrentUser() user: JwtUser
  ) {
    return this.conversationService.listRunStatuses(user.userId, body.ids);
  }

  @Post("update")
  update(@Body() body: UpdateConversationDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.update(user.userId, body.id, {
      title: body.title,
      status: body.status,
    });
  }

  @Post("archive")
  archive(@Body() body: ConversationIdDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.archive(user.userId, body.id);
  }

  @Post("unarchive")
  unarchive(@Body() body: ConversationIdDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.unarchive(user.userId, body.id);
  }

  @Post("remove")
  remove(@Body() body: ConversationIdDto, @CurrentUser() user: JwtUser) {
    return this.conversationService.delete(user.userId, body.id);
  }

  @Post("clear-archived")
  clearArchived(@CurrentUser() user: JwtUser) {
    return this.conversationService.clearArchived(user.userId);
  }

  @Get("messages/list")
  listMessages(
    @Query() query: ConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    return this.conversationService.listMessages(user.userId, query.id);
  }
}
