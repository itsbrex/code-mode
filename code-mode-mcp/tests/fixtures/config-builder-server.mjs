import { createServer } from "../../scripts/config-builder-server.mjs";
const ctx = JSON.parse(process.argv[2]);
const server = createServer({ manuals: [], manualCount: 0, toolCount: 0 }, ctx);
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("message", () => server.close(() => process.exit(0)));
