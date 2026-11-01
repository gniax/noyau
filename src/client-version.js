// A shared localStorage release marker can be updated by another tab while this
// WebView still runs an old JS bundle. Compare the executing bundle as well.
export function clientUpdateDecision({ runningVersion, serverVersion, serverRelease, knownRelease, lastAttempt }) {
  const releaseChanged = Boolean(knownRelease && serverRelease && knownRelease !== serverRelease);
  const runningOutdated = Boolean(runningVersion && serverVersion && runningVersion !== serverVersion);
  const attempt = `${runningVersion || ''}->${serverRelease || serverVersion || ''}`;
  return { reload: releaseChanged || runningOutdated && lastAttempt !== attempt, attempt, runningOutdated };
}
