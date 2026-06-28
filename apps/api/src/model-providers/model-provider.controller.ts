import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ModelProviderService } from "./model-provider.service";
import { ModelProviderIdDto } from "./dto/model-provider-id.dto";
import { ModelProviderAgentQueryDto } from "./dto/model-provider-query.dto";

@Controller("model-providers")
export class ModelProviderController {
  constructor(private modelProviderService: ModelProviderService) {}

  @Get("list")
  list(@Query() query: ModelProviderAgentQueryDto) {
    return this.modelProviderService.listEnabled(query.agentType);
  }

  @Get("system-info")
  systemInfo(@Query() query: ModelProviderAgentQueryDto) {
    return this.modelProviderService.getSystemInfo(query.agentType);
  }

  @Post("ping")
  ping(@Body() body: ModelProviderIdDto) {
    return this.modelProviderService.test(body.id);
  }
}
