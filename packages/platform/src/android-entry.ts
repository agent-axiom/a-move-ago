import { type AndroidAdapterConfig, createAndroidAdapter } from "./android";
import { capacitorAndroidBridge } from "./android-bridge";
import type { PlatformAdapter } from "./types";

export async function createCapacitorAndroidAdapter(
  config: AndroidAdapterConfig,
): Promise<PlatformAdapter | null> {
  return capacitorAndroidBridge.isNative()
    ? createAndroidAdapter(capacitorAndroidBridge, config)
    : null;
}
