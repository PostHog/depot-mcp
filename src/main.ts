import { createHttpServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const server = createHttpServer({ depotApiUrl: process.env.DEPOT_API_URL });
server.listen(port, host, () => {
  console.log(`depot-mcp listening on http://${host}:${port}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
