import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFileBytes,
  getFileIcon,
  getFileCategory,
  getMimeType,
  detectProjectFiles,
  parseCsvRows
} from "../src/project-file-utils.js";

test("formatFileBytes formats bytes properly in French", () => {
  assert.equal(formatFileBytes(0), "0 o");
  assert.equal(formatFileBytes(500), "500.0 o");
  assert.equal(formatFileBytes(1024), "1.0 Ko");
  assert.equal(formatFileBytes(1024 * 1024 * 2.5), "2.5 Mo");
});

test("getFileIcon and getFileCategory categorize extensions correctly", () => {
  assert.equal(getFileIcon(".png"), "🖼️");
  assert.equal(getFileCategory(".png"), "image");
  assert.equal(getMimeType(".png"), "image/png");

  assert.equal(getFileIcon(".pdf"), "📕");
  assert.equal(getFileCategory(".pdf"), "pdf");
  assert.equal(getMimeType(".pdf"), "application/pdf");

  assert.equal(getFileIcon(".mp4"), "🎬");
  assert.equal(getFileCategory(".mp4"), "video");

  assert.equal(getFileIcon(".mp3"), "🎵");
  assert.equal(getFileCategory(".mp3"), "audio");

  assert.equal(getFileIcon(".csv"), "📊");
  assert.equal(getFileCategory(".csv"), "csv");

  assert.equal(getFileIcon(".zip"), "📦");
  assert.equal(getFileCategory(".apk"), "other");
});

test("detectProjectFiles finds files mentioned in agent messages", () => {
  const files = [
    { name: "carte-liste-mobile.png", size: 383140 },
    { name: "noyau-0.155.0-ios-developpement.ipa", size: 16906449 },
    { name: "rapport.pdf", size: 54000 }
  ];

  const msg1 = "J'ai déposé le fichier carte-liste-mobile.png dans les fichiers partagés.";
  const detected1 = detectProjectFiles(msg1, files);
  assert.equal(detected1.length, 1);
  assert.equal(detected1[0].name, "carte-liste-mobile.png");

  const msg2 = "Voici les livrables : `carte-liste-mobile.png` et `noyau-0.155.0-ios-developpement.ipa`.";
  const detected2 = detectProjectFiles(msg2, files);
  assert.equal(detected2.length, 2);

  const msg3 = "Aucun fichier déposé ici.";
  const detected3 = detectProjectFiles(msg3, files);
  assert.equal(detected3.length, 0);
});

test("parseCsvRows parses simple and quoted CSV content", () => {
  const csv = "Nom,Prenom,Age\nDupont,Jean,30\n\"Martin, Jr.\",Claire,25";
  const parsed = parseCsvRows(csv);
  assert.deepEqual(parsed.headers, ["Nom", "Prenom", "Age"]);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[1], ["Martin, Jr.", "Claire", "25"]);
});
