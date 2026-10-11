import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { projectServers, stopProjectServers } from "../server/project-servers.js";

const roots = { nimbus: "nimbus.example", octanix: "octanix", atlas: "atlas.example" };
const [project, action = "status"] = process.argv.slice(2);
if (!roots[project] || !["status", "stop"].includes(action)) throw new Error("Usage: project-servers.mjs <nimbus|octanix|atlas> [status|stop]");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", roots[project]);
if (project === "nimbus" && action === "stop") {
  await promisify(execFile)("systemctl", ["--user", "stop", "nimbus-web.service"], { timeout: 20000 });
}
const result = await (action === "stop" ? stopProjectServers(root) : projectServers(root));
console.log(JSON.stringify({ action, ...result }, null, 2));
