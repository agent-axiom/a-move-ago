import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "../env";
import { ApiError, type ApiErrorStatus } from "./api-error";

function errorDetails(error: Error): {
  status: ApiErrorStatus;
  code: string;
  message: string;
} {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "The request is malformed.",
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Unexpected server error.",
  };
}

export function errorResponse(error: Error, context: Context<AppEnv>): Response {
  const details = errorDetails(error);
  return context.json(
    {
      error: {
        code: details.code,
        message: details.message,
        requestId: context.get("requestId"),
      },
    },
    details.status,
  );
}
