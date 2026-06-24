import { Controller, Get, Post, Body, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AgentService } from "./agent.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { JwtUser } from "../../auth/current-user.decorator";
import { AgentConversationIdDto, AgentReplyDto } from "./dto/agent-control.dto";
import { AgentRunRequestDto } from "./dto/agent-run.dto";
import { getAgentOptions } from "./agent-options";

@Controller("conversations/agent")
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get("options")
  options() {
    return getAgentOptions();
  }

  @Post("run")
  async run(
    @Body() body: AgentRunRequestDto,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.run(body, res, user);
  }

  @Get("resume")
  async resume(
    @Query("id") conversationId: string,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.resume(conversationId, res, user);
  }

  @Post("reply")
  async answerQuestion(
    @Body() body: AgentReplyDto,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.reply(body.id, body.answers, user);
  }

  @Post("stop")
  async stop(
    @Body() body: AgentConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentService.stop(body.id, user);
  }
}
