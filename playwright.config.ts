import { defineConfig } from "@playwright/test";

// Runs in recorded LLM mode. By default it targets the dev servers (starting them if needed);
// set BASE_URL (e.g. http://localhost:8787 for the Docker container) to test a server that is already running.
const baseURL = process.env.BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
