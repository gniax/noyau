import { AppIcon } from "./app-icon.jsx";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { isNative, nativeServer } from "./native-mobile.js";
import { biometricClient, biometricPasswordFallback, biometricStatus, disableBiometric, enableBiometric } from "./native-biometric.js";
import { tr, LOCALE } from "./i18n.js";

const biometricRuntime = { isNative, nativeServer, client: biometricClient, passwordFallback: biometricPasswordFallback, app: App };
const BACKGROUND_GRACE_MS = 5 * 60 * 1000;
export function BiometricBoundary({ children, runtime = biometricRuntime }) {
  const [childrenEpoch, setChildrenEpoch] = useState(0);
  const [gate, setGate] = useState(runtime.isNative ? "checking" : "open"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [label, setLabel] = useState(tr("Face ID / empreinte"));
  const working = useRef(false); const enabled = useRef(false); const profile = useRef(""); const unlocked = useRef(!runtime.isNative); const reauthAttempted = useRef(false); const lastUnlockAt = useRef(null); const backgroundAt = useRef(null); const hasOpened = useRef(!runtime.isNative);
  const unlock = useCallback(async () => {
    const now = runtime.now?.() ?? Date.now();
    let storedSessionUnlock = 0;
    try { storedSessionUnlock = Number(sessionStorage.getItem("noyau:last-biometric-unlock") || "0"); } catch {}
    const lastTime = Math.max(lastUnlockAt.current || 0, storedSessionUnlock);
    if (unlocked.current || (lastTime > 0 && now >= lastTime && now - lastTime < 30000)) {
      unlocked.current = true;
      setGate("open");
      return;
    }
    if (working.current) return; working.current = true; setBusy(true); setError("");
    try {
      await runtime.client(profile.current).unlock();
      const currentNow = runtime.now?.() ?? Date.now();
      lastUnlockAt.current = currentNow;
      try { sessionStorage.setItem("noyau:last-biometric-unlock", String(currentNow)); } catch {}
      unlocked.current = true;
      setGate("open");
    }
    catch (reason) { unlocked.current = false; setError(reason.message || tr("Authentification annulée.")); setGate("locked"); }
    finally { working.current = false; setBusy(false); }
  }, [runtime]);
  useEffect(() => {
    if (!runtime.isNative) return;
    let disposed = false; let listener;
    const inspect = async (auto = false) => {
      const now = runtime.now?.() ?? Date.now();
      let storedSessionUnlock = 0;
      try { storedSessionUnlock = Number(sessionStorage.getItem("noyau:last-biometric-unlock") || "0"); } catch {}
      const lastTime = Math.max(lastUnlockAt.current || 0, storedSessionUnlock);
      const recentlyUnlocked = lastTime > 0 && now >= lastTime && now - lastTime < 30000;
      if (recentlyUnlocked || unlocked.current) {
        unlocked.current = true;
        if (!disposed) setGate("open");
        return;
      }
      const id = localStorage.getItem("noyau:profile") || ""; profile.current = id;
      if (!id || !runtime.nativeServer()) { enabled.current = false; unlocked.current = true; if (!disposed) setGate("open"); return; }
      try {
        // Metadata determines whether the app is locked even when OS biometry is
        // unavailable/changed. Availability never silently removes the lock.
        const record = await runtime.client(id).record(); enabled.current = Boolean(record);
        if (disposed || working.current || id !== localStorage.getItem("noyau:profile")) return; setLabel(record?.label?.split(" · ")[0] || tr("Face ID / empreinte"));
        if (!record) { unlocked.current = true; setGate("open"); return; }
        if (auto && !unlocked.current) { setGate("locked"); await unlock(); }
      } catch { if (!disposed && !working.current && id === localStorage.getItem("noyau:profile")) { enabled.current = true; setGate("locked"); setError("Vérification du coffre impossible ; utilisez votre mot de passe."); } }
    };
    inspect(true);
    runtime.app.addListener("appStateChange", ({ isActive }) => {
      if (working.current) return; // The system biometric dialog is not an app exit.
      const now = runtime.now?.() ?? Date.now();
      if (!isActive && enabled.current && unlocked.current) { if (backgroundAt.current === null) backgroundAt.current = now; setGate("covered"); return; }
      if (isActive && backgroundAt.current !== null) {
        const elapsed = now - backgroundAt.current; backgroundAt.current = null;
        if (elapsed >= 0 && elapsed < BACKGROUND_GRACE_MS && unlocked.current) { setGate("open"); return; }
        reauthAttempted.current = false; unlocked.current = false; setGate("locked"); inspect(true); return;
      }
    }).then((handle) => { listener = handle; if (disposed) handle.remove(); });
    const changed = () => { if (!working.current) inspect(false); }; window.addEventListener("noyau:biometric-changed", changed);
    const reauthenticate = () => {
      const now = runtime.now?.() ?? Date.now();
      let storedSessionUnlock = 0;
      try { storedSessionUnlock = Number(sessionStorage.getItem("noyau:last-biometric-unlock") || "0"); } catch {}
      const lastTime = Math.max(lastUnlockAt.current || 0, storedSessionUnlock);
      const recentlyUnlocked = lastTime > 0 && now >= lastTime && now - lastTime < 30000;
      if (enabled.current && unlocked.current && !working.current && !recentlyUnlocked && backgroundAt.current === null && !reauthAttempted.current) {
        reauthAttempted.current = true;
        unlocked.current = false;
        setGate("locked");
        unlock();
      }
    }; window.addEventListener("noyau:biometric-reauth", reauthenticate);
    return () => { disposed = true; listener?.remove(); window.removeEventListener("noyau:biometric-changed", changed); window.removeEventListener("noyau:biometric-reauth", reauthenticate); };
  }, [unlock, runtime]);
  if (gate === "open") hasOpened.current = true;
  return <>{hasOpened.current && <div key={childrenEpoch} hidden={gate !== "open"} inert={gate !== "open"}>{children}</div>}{gate === "covered" ? <main className="login-shell" aria-label={tr("Noyau protégé")}><span className="boot-content">{tr("Noyau")}</span></main> : gate !== "open" && <main className="login-shell"><section className="login-card biometric-unlock" role="dialog" aria-modal="true" aria-label={tr("Déverrouiller Noyau")}><p style={{ margin: 0 }}><AppIcon name="lock" size={42}/></p><h1>{tr("Votre Noyau, protégé.")}</h1><p className="muted">{gate === "checking" ? tr("Vérification de la connexion sécurisée…") : tr("{0} pour ouvrir votre session. Vos données biométriques restent dans le téléphone.", label)}</p>{error && <p role="alert" className="form-error">{error}</p>}<button className="primary" disabled={busy || gate === "checking"} onClick={unlock}>{busy ? tr("Vérification…") : tr("Déverrouiller avec {0}", label)}</button><button className="ghost" disabled={busy || gate === "checking"} onClick={async () => { working.current = true; setBusy(true); try { await runtime.passwordFallback(); enabled.current = false; unlocked.current = true; setChildrenEpoch((value) => value + 1); setGate("open"); } catch (reason) { setError(reason.message); } finally { working.current = false; setBusy(false); } }}>{tr("Désactiver sur cet appareil et utiliser le mot de passe")}</button><small className="muted">{tr("Sans serveur/VPN, seule la copie locale reste accessible après vérification biométrique.")}</small></section></main>}</>;
}

export function BiometricSettings({ profileId, api }) {
  const [status, setStatus] = useState(null); const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [devices, setDevices] = useState([]);
  const refresh = useCallback(() => { biometricStatus(profileId).then(setStatus).catch(() => setStatus({ native: isNative, available: false, label: tr("Face ID / empreinte") })); api("/api/auth/biometric/devices").then((result) => setDevices(result.devices || [])).catch(() => {}); }, [profileId, api]);
  useEffect(refresh, [refresh]);
  return <><article className="setting-select-row biometric-setting"><span className="setting-symbol"><AppIcon name="lock"/></span><div><strong>{tr("Connexion Face ID / empreinte")}</strong><small>{!isNative ? tr("Disponible dans l’APK Android ou l’application iPhone signée, pas dans ce navigateur.") : status?.enabled ? `${status.label} activé · vérification à l’ouverture et après 5 minutes hors de l’application ; désactiver demande une reconnexion par mot de passe` : status?.available ? tr("{0} détecté · activation volontaire après confirmation du mot de passe", status.label) : "Configurez la biométrie du téléphone ; une biométrie forte est requise sur Android."}</small>{message && <small role="status">{message}</small>}</div><button className={`setting-toggle ${status?.enabled ? "on" : ""}`} disabled={busy || !isNative || !status || !status.enabled && !status.available} aria-pressed={Boolean(status?.enabled)} onClick={async () => { if (!status.enabled) { setConfirm(true); return; } setBusy(true); try { const result = await disableBiometric(profileId); setMessage(result.revoked ? tr("Connexion biométrique désactivée et accès révoqué.") : "Désactivée localement ; révoquez aussi cet appareil quand le serveur sera joignable."); await biometricPasswordFallback(); location.reload(); } catch (reason) { setMessage(reason.message); } finally { setBusy(false); } }}>{busy ? tr("Patientez…") : status?.enabled ? tr("Désactiver") : tr("Activer")}</button></article>
    {confirm && <article className="biometric-confirm"><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setMessage(""); try { await enableBiometric(profileId, password); setConfirm(false); setMessage(tr("Activée : la vérification système sera proposée automatiquement à l’ouverture.")); refresh(); } catch (reason) { setMessage(reason.message); } finally { setPassword(""); setBusy(false); } }}><label htmlFor="biometric-password">{tr("Confirmez le mot de passe de ce profil")}</label><input id="biometric-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /><p className="muted">{tr("Aucun mot de passe enregistré. Le jeton d’appareil est protégé par Keychain / Android Keystore et expire après 30 jours.")}</p><button className="primary" disabled={busy}>{tr("Activer avec la vérification système")}</button><button className="ghost" type="button" disabled={busy} onClick={() => { setConfirm(false); setPassword(""); }}>{tr("Annuler")}</button></form></article>}
    {devices.map((device) => <article key={device.id}><span className="setting-symbol"><AppIcon name="phone"/></span><div><strong>{device.name}</strong><small>{device.platform}{" "}{tr("· expire le")}{" "}{new Date(device.expiresAt).toLocaleDateString(LOCALE)}</small></div><button className="ghost" disabled={busy} onClick={async () => { setBusy(true); try { if (status?.record?.id === device.id) { await biometricPasswordFallback(); location.reload(); return; } else await api(`/api/auth/biometric/devices/${device.id}`, { method: "DELETE" }); setMessage(tr("Appareil révoqué.")); refresh(); } catch (reason) { setMessage(reason.message); } finally { setBusy(false); } }}>{tr("Révoquer")}</button></article>)}</>;
}
