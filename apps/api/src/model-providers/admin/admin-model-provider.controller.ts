import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CreateModelProviderDto } from "../dto/create-model-provider.dto";
import { ModelProviderIdDto } from "../dto/model-provider-id.dto";
import { ModelProviderAgentQueryDto } from "../dto/model-provider-query.dto";
import { SetModelProviderEnabledDto } from "../dto/set-model-provider-enabled.dto";
import { UpdateModelProviderDto } from "../dto/update-model-provider.dto";
import { ModelProviderService } from "../model-provider.service";

@Roles("admin")
@Controller("admin/model-providers")
export class AdminModelProviderController {
  constructor(private modelProviderService: ModelProviderService) {}

  @Get("list")
  list(@Query() query: ModelProviderAgentQueryDto) {
    return this.modelProviderService.listForAdmin(query.agentType);
  }

  @Post("create")
  create(@Body() body: CreateModelProviderDto) {
    return this.modelProviderService.create(
      body.agentType,
      body.name,
      body.providerConfig
    );
  }

  @Post("update")
  update(@Body() body: UpdateModelProviderDto) {
    return this.modelProviderService.update(
      body.id,
      body.name,
      body.providerConfig
    );
  }

  @Post("set-enabled")
  setEnabled(@Body() body: SetModelProviderEnabledDto) {
    return this.modelProviderService.setEnabled(body.id, body.isEnabled);
  }

  @Post("remove")
  remove(@Body() body: ModelProviderIdDto) {
    return this.modelProviderService.delete(body.id);
  }

  @Post("ping")
  ping(@Body() body: ModelProviderIdDto) {
    return this.modelProviderService.test(body.id, true);
  }
}
