import { createServer } from "node:net";

const DESKTOP_BACKEND_HOST = "127.0.0.1";
const MIN_DESKTOP_BACKEND_PORT = 49152;
const MAX_PORT_ATTEMPTS = 20;

/** Picks a free local TCP port for the backend to bind to. */
export async function pickAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await reserveEphemeralPort();
    if (port >= MIN_DESKTOP_BACKEND_PORT) return port;
  }

  throw new Error(
    `Could not allocate a high desktop backend port after ${MAX_PORT_ATTEMPTS} attempts`
  );
}

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.unref();
    server.once("error", reject);
    server.listen(0, DESKTOP_BACKEND_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to read allocated desktop backend port"));
          return;
        }
        resolve(port);
      });
    });
  });
}
