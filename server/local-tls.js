import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const exists = (file) => fs.access(file).then(() => true, () => false);

export function localAltNames(interfaces = os.networkInterfaces(), hostname = os.hostname()) {
  const addresses = Object.values(interfaces).flat().filter((item) => item && item.family === "IPv4").map((item) => item.address);
  const names = [...new Set(["localhost", hostname].filter(Boolean))].map((name) => `DNS:${name}`);
  return [...names, ...[...new Set(["127.0.0.1", ...addresses])].map((address) => `IP:${address}`)].join(",");
}

// The terminal, push and PWA features need HTTPS: a fresh install gets its own local authority.
export async function ensureLocalTls(dataDir, env = process.env) {
  if (env.NOYAU_TLS_CERT && env.NOYAU_TLS_KEY) return { generated: false, configured: true };
  const dir = path.join(dataDir, "tls");
  const ca = path.join(dir, "ca-cert.cer"), caKey = path.join(dir, "ca-key.pem");
  const cert = path.join(dir, "server-cert.pem"), key = path.join(dir, "server-key.pem");
  const generated = !(await exists(cert)) || !(await exists(key));
  if (generated) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const csr = path.join(dir, "server.csr"), ext = path.join(dir, "server.ext");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "3650", "-subj", "/CN=Noyau Local CA"]);
    await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=Noyau"]);
    await fs.writeFile(ext, `subjectAltName=${localAltNames()}\nextendedKeyUsage=serverAuth\n`);
    await run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "825", "-sha256", "-extfile", ext]);
    await Promise.all([fs.chmod(key, 0o600), fs.chmod(caKey, 0o600), fs.rm(csr, { force: true }), fs.rm(ext, { force: true })]);
  }
  env.NOYAU_TLS_CERT = cert;
  env.NOYAU_TLS_KEY = key;
  env.NOYAU_CA_CERT = ca;
  return { generated, configured: true };
}
