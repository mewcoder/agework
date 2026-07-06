import { Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/auth.types";
import { AgentService } from "./agent.service";
import { AgentConversationIdDto, AgentReplyDto } from "./dto/agent-control.dto";
import { AgentRunRequestDto } from "./dto/agent-run.dto";
import { CreateConversationDto } from "./dto/create-conversation.dto";

/**
 * Agent 交互入口 controller。路由前缀保持 `conversations`,公开 URL 不变。
 * 只做 HTTP I/O,业务编排交给 AgentService。
 */
@Controller("conversations")
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post("create")
  create(@Body() body: CreateConversationDto, @CurrentUser() user: JwtUser) {
    return this.agentService.createConversation(user.userId, body);
  }

  @Get("agent/options")
  agentOptions() {
    return this.agentService.getOptions();
  }

  @Post("agent/run")
  async runAgent(
    @Body() body: AgentRunRequestDto,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.run(body, res, user);
  }

  @Get("agent/resume")
  async resumeAgent(
    @Query() query: AgentConversationIdDto,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.resume(query.id, res, user);
  }

  @Post("agent/reply")
  async replyAgent(@Body() body: AgentReplyDto, @CurrentUser() user: JwtUser) {
    await this.agentService.reply(body.id, body.answers, user);
  }

  @Post("agent/stop")
  async stopAgent(
    @Body() body: AgentConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.stop(body.id, user);
  }
}
