import crypto from "node:crypto";

function signature(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest();
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createBuildGrant(secret, { moduleId, buildId, profileId, expiresAt }) {
  const payload = Buffer.from(JSON.stringify({ moduleId, buildId, profileId, expiresAt })).toString("base64url");
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

export function verifyBuildGrant(secret, token, now = Date.now()) {
  const [payload, encodedSignature, extra] = String(token || "").split(".");
  if (!payload || !encodedSignature || extra) return null;
  let supplied;
  try { supplied = Buffer.from(encodedSignature, "base64url"); } catch { return null; }
  const expected = signature(secret, payload);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  let grant;
  try { grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!grant?.moduleId || !grant?.buildId || !grant?.profileId || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) return null;
  return grant;
}

export function iosInstallManifest({ artifactUrl, bundleId, bundleVersion, title }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${xml(artifactUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xml(bundleId)}</string>
        <key>bundle-version</key>
        <string>${xml(bundleVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${xml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
