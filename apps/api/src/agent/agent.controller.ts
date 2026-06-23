import { Controller, Get, Post, Body, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AgentRunHandler } from "./agent-run-handler";
import { ConversationService } from "../conversations/conversation.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtUser } from "../auth/current-user.decorator";
import { AgentConversationIdDto, AgentReplyDto } from "./dto/agent-control.dto";
import { RunService } from "../runs/run.service";
import type { RunAgentInput } from "./run-agent-input";
import { getAgentPermissionOptions } from "./agent-permission-options";

@Controller("agent")
export class AgentController {
  constructor(
    private readonly agentRunHandler: AgentRunHandler,
    private readonly conversationService: ConversationService,
    private readonly runService: RunService
  ) {}

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
    await this.agentRunHandler.run(body, res, user);
  }

  @Get("run/resume")
  async resumeStream(
    @Query("id") conversationId: string,
    @Res() res: Response,
    @CurrentUser() user: JwtUser
  ) {
    await this.agentRunHandler.resumeStream(conversationId, res, user);
  }

  @Post("reply")
  async answerQuestion(
    @Body() body: AgentReplyDto,
    @CurrentUser() _user: JwtUser
  ) {
    await this.runService.resolveApproval(body.id, body.answers);
  }

  @Post("stop")
  async stop(
    @Body() body: AgentConversationIdDto,
    @CurrentUser() user: JwtUser
  ) {
    const conversationId = body.id;
    const conversation = await this.conversationService.findOne(user.userId, conversationId);
    const hadHandle = await this.runService.stop(conversationId);

    // If conversation was running but no in-memory handle existed, reset conversation status
    if (!hadHandle && conversation.activeRunStatus === "running") {
      await this.conversationService.setActiveRunStatus(conversationId, "idle");
    }
  }
}
