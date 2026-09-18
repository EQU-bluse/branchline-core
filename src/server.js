import { createServer } from "node:http";
import { handleRequest } from "./app.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = createServer(handleRequest);
server.listen(port, host, () => {
  console.log(`Branchline Core listening on http://${host}:${port}`);
});
