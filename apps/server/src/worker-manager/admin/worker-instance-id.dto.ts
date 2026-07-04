import { IsNotEmpty, IsString } from "class-validator";
import type { WorkerInstanceIdRequest } from "@agework/shared/api";

export class WorkerInstanceIdDto implements WorkerInstanceIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
