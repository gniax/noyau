import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

// Resolve and pin the public IPv4 address to the TLS connection: checking DNS
// separately from fetch would allow DNS rebinding into the local network.
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function publicTarget(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Lien de recette invalide.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.href.length > 2000 || net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan)$/i.test(url.hostname)) throw new Error('Lien HTTPS public requis.');
  url.hash = ''; return url;
}
export async function safePublicFetch(value, { headers = {}, signal } = {}) {
  const url = publicTarget(value); const addresses = await dns.resolve4(url.hostname);
  if (!addresses.length || addresses.some(ip => !publicIPv4(ip))) throw new Error('Adresse réseau non publique interdite.');
  const ip = addresses[0];
  return await new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, signal, lookup: (_host, opts, cb) => opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4) }, res => {
      const status = res.statusCode || 500; const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.destroy(new Error('Page trop volumineuse.')); return; } chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve(new Response([204,205,304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders })));
    }); req.on('error', reject); req.end();
  });
}
