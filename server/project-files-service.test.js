import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectFilesService } from "./project-files-service.js";

test("ProjectFilesService gère le téléversement, listing, téléchargement et suppression", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-project-files-test-"));
  try {
    const service = new ProjectFilesService({ dataDir: tempDir });
    const projectId = "project-test-123";

    // 1. Liste initiale vide
    const initialList = await service.list(projectId);
    assert.deepEqual(initialList, []);

    // 2. Sauvegarde d'un fichier
    const file1 = await service.saveFile(projectId, {
      originalname: "test.txt",
      buffer: Buffer.from("hello world", "utf8"),
    });
    assert.equal(file1.name, "test.txt");
    assert.equal(file1.size, 11);
    assert.equal(file1.extension, ".txt");

    // 3. Sauvegarde doublon: suffixé automatiquement
    const file2 = await service.saveFile(projectId, {
      originalname: "test.txt",
      buffer: Buffer.from("hello again", "utf8"),
    });
    assert.equal(file2.name, "test_1.txt");

    // 4. Liste contient les 2 fichiers
    const list = await service.list(projectId);
    assert.equal(list.length, 2);
    assert.ok(list.some((f) => f.name === "test.txt"));
    assert.ok(list.some((f) => f.name === "test_1.txt"));

    // 5. Lecture chemin sécurisé
    const targetPath = await service.getFilePath(projectId, "test.txt");
    const content = await fs.readFile(targetPath, "utf8");
    assert.equal(content, "hello world");

    // 6. Suppression
    await service.deleteFile(projectId, "test.txt");
    const listAfter = await service.list(projectId);
    assert.equal(listAfter.length, 1);
    assert.equal(listAfter[0].name, "test_1.txt");

    // 7. Rejet traversal
    await assert.rejects(
      () => service.getFilePath(projectId, "../../etc/passwd"),
      /Fichier introuvable/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
