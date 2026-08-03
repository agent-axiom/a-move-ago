export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

export class ApiError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
