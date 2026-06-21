import { IsNotEmpty, IsString } from "class-validator";
import type { WorkspaceIdRequest } from "@agework/shared/api";

export class WorkspaceIdDto implements WorkspaceIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
