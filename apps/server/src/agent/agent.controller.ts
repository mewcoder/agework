import { Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/auth.types";
import { AgentService } from "./agent.service";
import { AgentConversationIdDto, AgentReplyDto } from "./dto/agent-control.dto";
import { AgentSkillsDto } from "./dto/agent-skills.dto";
import { AgentRunRequestDto } from "./dto/agent-run.dto";
import { CreateConversationDto } from "./dto/create-conversation.dto";

/**
 * Agent 交互面 controller,独占 `agent/*` 前缀(对齐 worker 机器面 `worker/*`
 * 的写法),`conversations/*` 完全归 ConversationController。
 * `create-conversation`(动词-名词段,同 `auth/update-password` 形状)是
 * assistant-ui 运行时发首条消息前的 thread 铸造步骤,与 run/resume/reply/stop
 * 同属一条交互链路,不是 conversation 的通用 CRUD。
 * 只做 HTTP I/O,业务编排交给 AgentService。
 */
@Controller("agent")
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post("create-conversation")
  create(@Body() body: CreateConversationDto, @CurrentUser() user: JwtUser) {
    return this.agentService.createConversation(user.userId, body);
  }

  @Get("options")
  agentOptions() {
    return this.agentService.getOptions();
  }

  @Get("skills")
  agentSkills(
    @Query() query: AgentSkillsDto,
    @CurrentUser() user: JwtUser
  ) {
    return this.agentService.getSkills(user.userId, query.workspaceId, query.agentType);
  }

  @Post("run")
  async runAgent(
    @Body() body: AgentRunRequestDto,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.run(body, res, user);
  }

  @Get("resume")
  async resumeAgent(
    @Query() query: AgentConversationIdDto,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.resume(query.id, res, user);
  }

  @Post("reply")
  async replyAgent(@Body() body: AgentReplyDto, @CurrentUser() user: JwtUser) {
    await this.agentService.reply(body.id, body.answers, user);
  }

  @Post("stop")
  async stopAgent(
    @Body() body: AgentConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.stop(body.id, user);
  }
}
