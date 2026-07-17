/** Worker 上报请求本身无效；HTTP 层应返回 4xx，避免无意义重试。 */
export class WorkerEventRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerEventRequestError";
  }
}
