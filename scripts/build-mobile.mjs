#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

console.log("📱 Préparation du build mobile Noyau (APK / IPA)...");

// 1. Build Web Vite
console.log("📦 Compilation des assets web avec Vite...");
execSync("npm run build", { cwd: root, stdio: "inherit" });

if (!fs.existsSync(distDir)) {
  console.error("❌ Erreur : le dossier dist n'existe pas après le build.");
  process.exit(1);
}

// 2. Vérification Capacitor
console.log("⚙️  Vérification de la configuration Capacitor...");
const capConfigPath = path.join(root, "capacitor.config.json");
if (!fs.existsSync(capConfigPath)) {
  console.error("❌ Erreur : capacitor.config.json manquant.");
  process.exit(1);
}

console.log("✅ Configuration prête dans capacitor.config.json");
console.log("");
console.log("Pour générer les paquets natifs :");
console.log("1. Android (APK) :");
console.log("   npx cap add android");
console.log("   npx cap sync android");
console.log("   cd android && ./gradlew assembleDebug  # Sortie: android/app/build/outputs/apk/debug/app-debug.apk");
console.log("");
console.log("2. iOS (IPA) :");
console.log("   npx cap add ios");
console.log("   npx cap sync ios");
console.log("   npx cap open ios                      # Ouvrir dans Xcode pour archive / IPA");
console.log("");
console.log("✨ Prêt pour packaging mobile.");
