import { IsNotEmpty, IsString } from "class-validator";

/** 定向停止 worker:runtimeHostId 选择目标 Host,workerId 定位其上的 worker。 */
export class StopWorkerDto {
  @IsString()
  @IsNotEmpty()
  runtimeHostId!: string;

  @IsString()
  @IsNotEmpty()
  workerId!: string;
}
