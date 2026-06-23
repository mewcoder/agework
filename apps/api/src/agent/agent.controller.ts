import { Controller, Get, Post, Body, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AgentService } from "./agent.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtUser } from "../auth/current-user.decorator";
import { AgentConversationIdDto, AgentReplyDto } from "./dto/agent-control.dto";
import type { RunAgentInput } from "./run-agent-input";
import { getAgentPermissionOptions } from "./agent-permission-options";

@Controller("agent")
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get("permission-options")
  permissionOptions() {
    return getAgentPermissionOptions();
  }

  @Post("run")
  async run(
    @Body() body: RunAgentInput,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.run(body, res, user);
  }

  @Get("run/resume")
  async resumeStream(
    @Query("id") conversationId: string,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.resumeStream(conversationId, res, user);
  }

  @Post("reply")
  async answerQuestion(
    @Body() body: AgentReplyDto,
    @CurrentUser() _user: JwtUser
  ) {
    await this.agentService.reply(body.id, body.answers);
  }

  @Post("stop")
  async stop(
    @Body() body: AgentConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.stop(body.id, user);
  }
}
