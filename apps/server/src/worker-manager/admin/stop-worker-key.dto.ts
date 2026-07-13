import { IsNotEmpty, IsString } from "class-validator";

/** Phase 2: 通过 WorkerKey 停止 worker（走 hostContract.stopWorker，覆盖 managed + registered）。 */
export class StopWorkerKeyDto {
  @IsString()
  @IsNotEmpty()
  workerKey!: string;
}
