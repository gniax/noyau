// Native WebViews cannot load private API URLs as static media or use browser downloads.
export async function readProjectFile(url, { fetcher = fetch, headers = {} } = {}) {
  const response = await fetcher(url, { credentials: "include", headers });
  if (!response.ok) throw new Error(`Téléchargement impossible (${response.status}).`);
  return response.blob();
}

export async function shareProjectFile(blob, filename, { writeFile, share }) {
  if (!filename || filename === "." || filename === ".." || /[/\\\x00-\x1f]/.test(filename)) throw new Error("Nom de fichier invalide.");
  if (blob.size > 120 * 1024 * 1024) throw new Error("Fichier trop volumineux pour le partage dans l’application.");
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  const file = await writeFile({ path: `shared-files/${filename}`, data: btoa(binary), recursive: true });
  if (!file?.uri) throw new Error("Enregistrement local impossible.");
  await share({ title: filename, files: [file.uri], dialogTitle: "Enregistrer ou partager le fichier" });
}
