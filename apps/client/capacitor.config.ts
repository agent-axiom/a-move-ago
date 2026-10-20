import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.agentaxiom.amoveago",
  appName: "A MOVE AGO",
  webDir: "dist/android",
  backgroundColor: "#151718",
  server: {
    androidScheme: "https",
    hostname: "localhost",
  },
};

export default config;
