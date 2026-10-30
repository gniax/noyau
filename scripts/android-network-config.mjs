import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

// The personal CA is generated into ignored build variants, never into Git or
// the public website. Only the configured server host trusts this anchor.
export function androidNetworkXml(origin) {
  let url; try { url = new URL(origin); } catch { throw new Error("Adresse native HTTPS invalide."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Adresse native HTTPS invalide.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || !(net.isIP(host) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) || host.length > 253) throw new Error("Hôte natif invalide.");
  return `<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors></base-config>\n  <domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">${host}</domain><trust-anchors><certificates src="system" /><certificates src="user" /><certificates src="@raw/noyau_local_ca" /></trust-anchors></domain-config>\n</network-security-config>\n`;
}
export async function configureAndroidNetworkResources(root, origin, certificate) {
  let xml = null;
  if (origin && certificate) {
    const x509 = new crypto.X509Certificate(certificate); if (!x509.ca) throw new Error("Le certificat fourni n'est pas une autorité de certification.");
    xml = androidNetworkXml(origin);
  }
  for (const variant of ["debug", "release"]) {
    const base = path.join(root, "android/app/src", variant, "res"); const config = path.join(base, "xml/network_security_config.xml"), cert = path.join(base, "raw/noyau_local_ca.cer");
    if (!xml) { await fs.rm(config, { force: true }); await fs.rm(cert, { force: true }); continue; }
    await fs.mkdir(path.dirname(config), { recursive: true }); await fs.mkdir(path.dirname(cert), { recursive: true });
    await fs.writeFile(config, xml, { mode: 0o600 }); await fs.writeFile(cert, certificate, { mode: 0o600 });
  }
  return Boolean(xml);
}
