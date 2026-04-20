#!/usr/bin/env node
/**
 * autostore-in-chrome daemon entry point.
 *
 * Long-running process. Started by launchd (or `node dist/index.js` for dev).
 * Loads or creates the shared token, opens the loopback server, and waits
 * for a Chrome extension to connect.
 */
import { loadOrCreateToken, writePort, DEFAULT_PORT } from "./handshake.js";
import { ExtensionBus } from "./extension-bus.js";
import { createDaemonServer } from "./server.js";

const DAEMON_VERSION = "0.1.0";

async function main() {
  const token = loadOrCreateToken();
  const port = Number(process.env.AUTOSTORE_IN_CHROME_PORT ?? DEFAULT_PORT);

  const backendUrl = process.env.AUTOSTORE_BACKEND_URL ?? "https://api.spriterock.com";
  const bus = new ExtensionBus({ token, daemonVersion: DAEMON_VERSION });
  const server = createDaemonServer({ token, port, daemonVersion: DAEMON_VERSION, bus, backendUrl });

  await server.listen();
  writePort(port);

  process.stderr.write(
    `[daemon] autostore-in-chrome v${DAEMON_VERSION} listening on 127.0.0.1:${port}\n` +
      `[daemon] token: ~/.autostore-in-chrome/token\n` +
      `[daemon] waiting for Chrome extension...\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[daemon] ${signal} — shutting down\n`);
    bus.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[daemon] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
