import type { Context } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "./api-error";

export async function requestJson(context: Context<AppEnv>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiError(400, "INVALID_REQUEST", "The request is malformed.");
    }
    throw error;
  }
}
