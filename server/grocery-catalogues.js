const months = {janv:1,'févr':2,fevr:2,mars:3,avr:4,mai:5,juin:6,juil:7,août:8,aout:8,sept:9,oct:10,nov:11,'déc':12,dec:12};
const date = (day, month, year) => {
  const number = months[month.toLowerCase().replace(/\.$/, '')];
  if (!number) return null;
  const value = `${year}-${String(number).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value ? value : null;
};
export function parseLeclercCatalogues(html, today, { keepVariants = false } = {}) {
  const result = [];
  for (const match of String(html).matchAll(/<button\b[^>]*data-operation-code[^>]*>/gi)) {
    const tag = match[0]; const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
    const label = tag.match(/\baria-label="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
    if (!href || !label || /brico|jardin|jouet|high.tech|électroménager|bijou|animaux|d[ée]co|auto|voyage|jeu vid|\bbd\b/i.test(label) || !/pouvoir|courses|promo|aliment|march[ée]|gourmand|marques/i.test(label)) continue;
    let url; try { url = new URL(href); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'nos-catalogues-promos-v2.e.leclerc' || !/^\/catalog\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(url.pathname)) continue;
    const dates = label.match(/\bDu\s+(\d{1,2})\s+([\p{L}.]+)(?:\s+(\d{4}))?\s+au\s+(\d{1,2})\s+([\p{L}.]+)\s+(\d{4})/iu);
    if (!dates) continue;
    const end = date(dates[4], dates[5], dates[6]); let start = date(dates[1], dates[2], dates[3] || dates[6]);
    if (start && end && start > end && !dates[3]) start = date(dates[1], dates[2], Number(dates[6])-1);
    if (!start || !end || end < today) continue;
    if (!keepVariants && result.some((item) => item.title === label.replace(/^Afficher le catalogue\s+/i,'').slice(0,160) && item.startsAt === start && item.endsAt === end)) continue;
    result.push({ title: label.replace(/^Afficher le catalogue\s+/i,'').slice(0,160), sourceUrl: url.href, startsAt: start, endsAt: end });
    if (result.length >= 30) break;
  }
  return result;
}
