import { Module } from "@nestjs/common";
import { AdminModelProviderController } from "./admin/admin-model-provider.controller";
import { ModelProviderController } from "./model-provider.controller";
import { ModelProviderService } from "./model-provider.service";

@Module({
  controllers: [ModelProviderController, AdminModelProviderController],
  providers: [ModelProviderService],
  exports: [ModelProviderService],
})
export class ModelProviderModule {}
