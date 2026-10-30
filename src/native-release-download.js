// Fetch the authenticated artifact inside the native app: Safari does not share
// the app's cookies or its private CA trust. The OS share sheet saves/transfers it.
export async function saveAndShareRelease({ url, filename, fetcher, writeFile, statFile, share, install }) {
  if (!/^noyau-[a-zA-Z0-9._-]+\.(apk|ipa)$/.test(filename)) throw new Error("Nom de fichier application invalide.");
  const response = await fetcher(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Téléchargement impossible (${response.status}).`);
  const limit = 120 * 1024 * 1024; const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) throw new Error("Fichier application trop volumineux.");
  const bytes = new Uint8Array(await response.arrayBuffer()); if (!bytes.length || bytes.length > limit) throw new Error("Fichier application vide ou trop volumineux.");
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error("L’application téléchargée n’est pas une archive valide.");
  let binary = ""; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  const target = `releases/${filename}`; let file;
  try { file = await writeFile({ path: target, data: btoa(binary), recursive: true }); }
  catch (error) { throw new Error(`Enregistrement local impossible : ${error.message}`); }
  if (!file?.uri) throw new Error("Enregistrement local sans adresse de fichier.");
  if (statFile) {
    let stat; try { stat = await statFile({ path: target }); } catch (error) { throw new Error(`Vérification du fichier local impossible : ${error.message}`); }
    if (Number(stat.size) !== bytes.length) throw new Error("Fichier local incomplet : réessayez le téléchargement.");
  }
  if (install) return install({ path: target });
  try { await share({ title: filename, files: [file.uri], dialogTitle: "Enregistrer ou partager l’application" }); }
  catch (error) { throw new Error(`Partage impossible : ${error.message}`); }
}
