#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { configureAndroidNetworkResources } from "./android-network-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2] || "android";
const prepareOnly = process.argv.includes("--prepare-only");
const share = process.argv.includes("--share");
if (!["android", "ios"].includes(platform)) throw new Error("Usage: node scripts/build-mobile.mjs android|ios [--prepare-only] [--share]");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const [major, minor, patch] = version.split(".").map(Number); const versionCode = major * 1000000 + minor * 1000 + patch;
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
run("npm", ["run", "build"]);
const icon = await fs.readFile(path.join(root, "public/icon.svg"));
if (platform === "android") {
  const gradle = path.join(root, "android/app/build.gradle");
  await fs.writeFile(gradle, (await fs.readFile(gradle, "utf8")).replace(/versionCode \d+/, `versionCode ${versionCode}`).replace(/versionName "[^"]+"/, `versionName "${version}"`));
  for (const [density, size, foreground] of [["mdpi", 48, 108], ["hdpi", 72, 162], ["xhdpi", 96, 216], ["xxhdpi", 144, 324], ["xxxhdpi", 192, 432]]) {
    for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) await sharp(icon).resize(size, size).png().toFile(path.join(root, `android/app/src/main/res/mipmap-${density}/${name}`));
    await sharp(icon).resize(foreground, foreground).png().toFile(path.join(root, `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`));
  }
} else {
  const project = path.join(root, "ios/App/App.xcodeproj/project.pbxproj");
  await fs.writeFile(project, (await fs.readFile(project, "utf8")).replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`));
  await sharp(icon).resize(1024, 1024).png().toFile(path.join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"));
}
run("npx", ["cap", "sync", platform]);
// Instance-specific non-secret connection hints and the public CA are bundled only
// into native assets, never Git or the web server's dist directory.
const connectionPath = path.join(root, ".data/native-connection.json");
const connection = await fs.readFile(connectionPath, "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
let nativeCertificate = null;
const assets = path.join(root, platform === "ios" ? "ios/App/App/public" : "android/app/src/main/assets/public");
if (connection) {
  const target = new URL(connection.homeUrl);
  if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Adresse native HTTPS invalide dans .data/native-connection.json.");
  let hasCertificate = false; let caFingerprint = null;
  if (connection.publicCaFile) {
    const certFile = await fs.realpath(path.resolve(root, connection.publicCaFile));
    const allowed = (await fs.realpath(path.join(root, ".data/tls"))) + path.sep;
    if (!certFile.startsWith(allowed) || !certFile.endsWith(".cer")) throw new Error("Certificat public attendu dans .data/tls/*.cer.");
    const certificate = await fs.readFile(certFile); if (certificate.length < 100 || certificate.length > 20000 || certificate.includes(Buffer.from("PRIVATE KEY"))) throw new Error("Certificat public invalide.");
    const x509 = new crypto.X509Certificate(certificate); if (!x509.ca) throw new Error("Le certificat fourni n'est pas une autorité de certification."); caFingerprint = x509.fingerprint256; nativeCertificate = certificate;
    await fs.writeFile(path.join(assets, "native-home-ca.cer"), certificate); hasCertificate = true;
  }
  await fs.writeFile(path.join(assets, "native-home.json"), JSON.stringify({ homeUrl: target.origin, hasCertificate, caFingerprint }) + "\n");
} else {
  await fs.rm(path.join(assets, "native-home.json"), { force: true });
  await fs.rm(path.join(assets, "native-home-ca.cer"), { force: true });
}
if (platform === "android") await configureAndroidNetworkResources(root, connection?.homeUrl, nativeCertificate);
if (prepareOnly) { console.log(`${platform}: sources et ressources synchronisées (${version}), aucun binaire prétendu.`); process.exit(0); }
const output = path.join(root, ".data/mobile-builds"); await fs.mkdir(output, { recursive: true, mode: 0o700 });
let artifact; let kind;
if (platform === "android") {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "Android/Sdk");
  run(path.join(root, "android/gradlew"), ["-p", "android", "assembleDebug"], { env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } });
  artifact = path.join(output, `noyau-${version}-android-debug.apk`); kind = "debug";
  await fs.copyFile(path.join(root, "android/app/build/outputs/apk/debug/app-debug.apk"), artifact);
} else {
  if (process.platform !== "darwin") throw new Error("IPA non générée : un Mac avec Xcode, une équipe Apple et un profil de signature sont requis ; utiliser --prepare-only sur Linux.");
  if (!process.env.APPLE_TEAM_ID || !process.env.NOYAU_IOS_EXPORT_OPTIONS) throw new Error("APPLE_TEAM_ID et NOYAU_IOS_EXPORT_OPTIONS requis ; aucun certificat ne doit être ajouté au dépôt.");
  const archive = path.join(output, "Noyau.xcarchive"); const exported = path.join(output, "ios-export");
  run("xcodebuild", ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archive, `DEVELOPMENT_TEAM=${process.env.APPLE_TEAM_ID}`, "archive"]);
  run("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exported, "-exportOptionsPlist", process.env.NOYAU_IOS_EXPORT_OPTIONS]);
  const name = (await fs.readdir(exported)).find((file) => file.endsWith(".ipa")); if (!name) throw new Error("Xcode n'a produit aucune IPA signée.");
  artifact = path.join(output, `noyau-${version}-ios.ipa`); kind = "signed"; await fs.copyFile(path.join(exported, name), artifact);
}
if (share) {
  const result = execFileSync(process.execPath, ["scripts/noyau-file.mjs", "put", artifact, path.basename(artifact)], { cwd: root, encoding: "utf8" });
  const uploaded = JSON.parse(result); if (!uploaded.success) throw new Error("Dépôt du binaire dans les Fichiers partagés non confirmé.");
  const manifestFile = path.join(root, ".data/mobile-releases.json"); const current = await fs.readFile(manifestFile, "utf8").then(JSON.parse).catch(() => ({}));
  await fs.writeFile(manifestFile, JSON.stringify({ ...current, [platform === "android" ? "android" : "ios"]: { version, kind, filename: uploaded.filename, url: uploaded.url, builtAt: new Date().toISOString() } }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ shared: true, filename: uploaded.filename, version, kind }));
} else console.log(`${platform} ${version} : binaire produit (${kind}). Utiliser --share pour le déposer dans les Fichiers partagés.`);
