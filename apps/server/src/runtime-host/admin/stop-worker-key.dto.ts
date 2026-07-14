import { IsNotEmpty, IsString } from "class-validator";

/** 通过 WorkerKey 停止 worker（走 hostContract.stopWorker，覆盖 builtin + registered）。 */
export class StopWorkerKeyDto {
  @IsString()
  @IsNotEmpty()
  workerKey!: string;
}
