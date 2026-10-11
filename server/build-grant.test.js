import assert from "node:assert/strict";
import test from "node:test";
import { createBuildGrant, createProjectFileGrant, iosInstallManifest, verifyBuildGrant, verifyProjectFileGrant } from "./build-grant.js";

test("build grant expires and rejects modifications", () => {
  const secret = Buffer.alloc(32, 7);
  const expiresAt = 2_000_000;
  const token = createBuildGrant(secret, { moduleId: "project-app--build", buildId: "app.ipa", profileId: "profile-a", expiresAt });
  assert.deepEqual(verifyBuildGrant(secret, token, expiresAt - 1), { moduleId: "project-app--build", buildId: "app.ipa", profileId: "profile-a", expiresAt });
  assert.equal(verifyBuildGrant(secret, `${token}x`, expiresAt - 1), null);
  assert.equal(verifyBuildGrant(secret, token, expiresAt), null);
});

test("iOS install manifest escapes metadata and carries HTTPS artifact", () => {
  const manifest = iosInstallManifest({
    artifactUrl: "https://10.0.0.1:4243/install/file.ipa?x=1&y=2",
    bundleId: "com.example.app",
    bundleVersion: "1.2.3",
    title: "App <VPN>",
  });
  assert.match(manifest, /software-package/);
  assert.match(manifest, /https:\/\/10\.0\.0\.1:4243\/install\/file\.ipa\?x=1&amp;y=2/);
  assert.match(manifest, /App &lt;VPN&gt;/);
});

test("project file grant signs, verifies and expires", () => {
  const secret = Buffer.alloc(32, 7);
  const now = 1_000_000;
  const token = createProjectFileGrant(secret, {
    projectId: "project-123",
    filename: "test.png",
    profileId: "main",
    expiresAt: now + 5000,
  });
  const verified = verifyProjectFileGrant(secret, token, now);
  assert.equal(verified?.projectId, "project-123");
  assert.equal(verified?.filename, "test.png");
  assert.equal(verified?.profileId, "main");

  // Rejette après expiration
  assert.equal(verifyProjectFileGrant(secret, token, now + 6000), null);
  // Rejette altération
  assert.equal(verifyProjectFileGrant(secret, `${token}x`, now), null);
});

