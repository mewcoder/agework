import { Module } from "@nestjs/common";
import { AdminModelProviderController } from "./admin/admin-model-provider.controller";
import { ModelProviderController } from "./model-provider.controller";
import { ModelProviderService } from "./model-provider.service";
import { ModelProviderRepository } from "./model-provider.repository";

@Module({
  controllers: [ModelProviderController, AdminModelProviderController],
  providers: [ModelProviderService, ModelProviderRepository],
  exports: [ModelProviderService],
})
export class ModelProviderModule {}
