import { LOCALE, tr } from './i18n.js';
export function quotaResetDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return tr('Reset inconnu');
  return `${tr('Reset')} ${new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}
