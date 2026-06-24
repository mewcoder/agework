import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ModelProviderService } from "./model-provider.service";
import { ModelProviderIdDto } from "./dto/model-provider-id.dto";

@Controller("model-providers")
export class ModelProviderController {
  constructor(private modelProviderService: ModelProviderService) {}

  @Get("list")
  list(@Query("agentType") agentType: string) {
    return this.modelProviderService.listEnabled(agentType);
  }

  @Get("system-info")
  systemInfo(@Query("agentType") agentType: string) {
    return this.modelProviderService.getSystemInfo(agentType);
  }

  @Post("ping")
  ping(@Body() body: ModelProviderIdDto) {
    return this.modelProviderService.test(body.id);
  }
}
