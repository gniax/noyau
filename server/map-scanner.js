import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Scanner générique de la carte: noms de clés .env, hôtes d'API et SDK trouvés dans un dossier projet.
// Les valeurs ne sortent jamais d'ici: seuls les noms (clés, hôtes, paquets) et les chemins sont conservés.

const SKIP_DIRS = new Set(["node_modules", "vendor", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".cache", ".parcel-cache", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".vscode", "tmp", "logs", "uploads", ".data", "Pods", "dumps", "backups", "site-packages", ".dart_tool", "DerivedData", ".noyau", "images", "img", "fonts", "media", "videos", "screenshots", "captures"]);
const CODE_FILE = /\.(php|js|mjs|cjs|ts|tsx|jsx|py|sh|go|dart|kt|swift|rb|vue|svelte)$/i;
const ENV_FILE = /(^\.env(\..+)?$|\.env$)/;
const MANIFEST_FILE = /^(package\.json|composer\.json|requirements[\w.-]*\.txt|pyproject\.toml|pubspec\.yaml)$/;
// Fichiers de configuration sensibles: jamais ouverts, même pour y chercher des noms d'hôtes.
const SENSITIVE_FILE = /(^|\/)(config\.php|secrets?[\w.-]*|credentials?[\w.-]*|[\w.-]*\.(key|pem|p12|token))$/i;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 8_000;
const MAX_VISITED = 250_000;
const MAX_EVIDENCE_FILES = 12;

// Correspondance hôte / clé / SDK → fournisseur. Extensible via .data/map-providers.json (même forme).
export const PROVIDERS = [
  { slug: "solana-rpc", label: "Solana RPC", hosts: ["helius-rpc.com", "helius.xyz", "api.mainnet-beta.solana.com", "solana-mainnet.g.alchemy.com", "quiknode.pro"], keys: [/^SOLANA_RPC/, /^HELIUS_/], sdks: ["@solana/web3.js", "solana", "solders"] },
  { slug: "stripe", label: "Stripe", hosts: ["api.stripe.com", "js.stripe.com", "checkout.stripe.com"], keys: [/^STRIPE_/], sdks: ["stripe", "stripe/stripe-php", "@stripe/stripe-js"], cost: "commission" },
  { slug: "nowpayments", label: "NOWPayments", hosts: ["api.nowpayments.io", "api-sandbox.nowpayments.io"], keys: [/^NOWPAYMENTS_/], cost: "commission" },
  { slug: "coinpayments", label: "CoinPayments", hosts: ["coinpayments.net"], keys: [/^COINPAYMENTS_/], cost: "commission" },
  { slug: "paypal", label: "PayPal", hosts: ["api.paypal.com", "api-m.paypal.com", "api.sandbox.paypal.com"], keys: [/^PAYPAL_/], sdks: ["@paypal/checkout-server-sdk"], cost: "commission" },
  { slug: "qonto", label: "Qonto", hosts: ["thirdparty.qonto.com", "qonto.com"], keys: [/^QONTO_/] },
  { slug: "enable-banking", label: "Enable Banking", hosts: ["api.enablebanking.com"], keys: [/^ENABLE_BANKING/] },
  { slug: "pinata", label: "Pinata (IPFS)", hosts: ["api.pinata.cloud", "gateway.pinata.cloud", "mypinata.cloud"], keys: [/^PINATA_/] },
  { slug: "jupiter", label: "Jupiter (swap Solana)", hosts: ["jup.ag", "quote-api.jup.ag", "lite-api.jup.ag", "api.jup.ag"], keys: [/^JUPITER_/] },
  { slug: "reown", label: "WalletConnect / Reown", hosts: ["walletconnect.com", "reown.com", "walletconnect.org"], keys: [/^(WALLETCONNECT|REOWN)_/], sdks: ["@reown/appkit", "@walletconnect/web3-provider"] },
  { slug: "turnstile", label: "Cloudflare Turnstile", hosts: ["challenges.cloudflare.com"], keys: [/^TURNSTILE_/] },
  { slug: "cloudflare", label: "Cloudflare", hosts: ["api.cloudflare.com"], keys: [/^(CLOUDFLARE|CF)_/], sdks: ["cloudflare"] },
  { slug: "hetzner", label: "Hetzner", hosts: ["api.hetzner.cloud", "robot-ws.your-server.de"], keys: [/^HETZNER_/, /^HCLOUD_/] },
  { slug: "brevo", label: "Brevo", hosts: ["api.brevo.com", "api.sendinblue.com"], keys: [/^(BREVO|SENDINBLUE)_/], sdks: ["@getbrevo/brevo", "sib-api-v3-sdk"] },
  { slug: "listmonk", label: "listmonk", hosts: [], keys: [/^LISTMONK_/] },
  { slug: "ses", label: "Amazon SES", hosts: ["amazonaws.com/ses", "email.eu-west-1.amazonaws.com"], keys: [/^(AWS_SES|SES)_/], sdks: ["@aws-sdk/client-ses"] },
  { slug: "aws", label: "AWS", hosts: ["amazonaws.com"], keys: [/^AWS_/], sdks: ["aws-sdk", "@aws-sdk/client-s3", "boto3", "aws/aws-sdk-php"], cost: "usage" },
  { slug: "sendgrid", label: "SendGrid", hosts: ["api.sendgrid.com"], keys: [/^SENDGRID_/], sdks: ["@sendgrid/mail", "sendgrid/sendgrid"] },
  { slug: "mailgun", label: "Mailgun", hosts: ["api.mailgun.net", "api.eu.mailgun.net"], keys: [/^MAILGUN_/], sdks: ["mailgun.js", "mailgun/mailgun-php"] },
  { slug: "resend", label: "Resend", hosts: ["api.resend.com"], keys: [/^RESEND_/], sdks: ["resend"] },
  { slug: "smtp", label: "Serveur SMTP", hosts: [], keys: [/^(SMTP|MAIL)_(HOST|USER|PASS|PASSWORD|PORT)/], sdks: ["nodemailer", "phpmailer/phpmailer"] },
  { slug: "onesignal", label: "OneSignal (push)", hosts: ["onesignal.com", "api.onesignal.com"], keys: [/^ONESIGNAL_/], sdks: ["onesignal-node", "react-native-onesignal", "onesignal_flutter"] },
  { slug: "firebase", label: "Firebase", hosts: ["firebaseio.com", "fcm.googleapis.com", "firebasestorage.googleapis.com", "identitytoolkit.googleapis.com"], keys: [/^FIREBASE_/, /^FCM_/], sdks: ["firebase", "firebase-admin", "firebase_core", "firebase_messaging", "kreait/firebase-php"] },
  { slug: "telegram-user", label: "Telegram API utilisateur", hosts: ["my.telegram.org"], keys: [/^TG_API_(ID|HASH)$/, /^TELEGRAM_API_(ID|HASH)$/, /^TG_SESSION/], sdks: ["telethon", "pyrogram", "telegram", "gramjs"], cost: "free" },
  { slug: "telegram", label: "Telegram Bot API", hosts: ["api.telegram.org"], keys: [/^TELEGRAM_/, /_BOT_TOKEN$/, /^TG_BOT/], sdks: ["node-telegram-bot-api", "telegraf", "grammy", "python-telegram-bot", "aiogram"], cost: "free" },
  { slug: "x", label: "X API", hosts: ["api.twitter.com", "api.x.com", "upload.twitter.com"], keys: [/^(TWITTER|X)_(CONSUMER|API|ACCESS|BEARER|CLIENT)/], sdks: ["twitter-api-v2", "tweepy", "abraham/twitteroauth"] },
  { slug: "twitterapi-io", label: "twitterapi.io", hosts: ["api.twitterapi.io"], keys: [/^TWITTERAPI_/] },
  { slug: "fxtwitter", label: "FxTwitter", hosts: ["api.fxtwitter.com", "fxtwitter.com"], keys: [], cost: "free" },
  { slug: "nitter", label: "Nitter", hosts: ["nitter.net"], keys: [/NITTER/], cost: "free" },
  { slug: "capsolver", label: "CapSolver", hosts: ["api.capsolver.com"], keys: [/^CAPSOLVER_/], sdks: ["capsolver"], cost: "usage" },
  { slug: "2captcha", label: "2Captcha", hosts: ["2captcha.com"], keys: [/^(TWOCAPTCHA|2CAPTCHA|CAPTCHA)_/], sdks: ["2captcha-python", "2captcha-ts"], cost: "usage" },
  { slug: "proxy6", label: "Proxy6 (proxys)", hosts: ["proxy6.net"], keys: [/^PROXY6_/], cost: "subscription" },
  { slug: "sproutgigs", label: "SproutGigs", hosts: ["sproutgigs.com", "picoworkers.com"], keys: [/^SPROUTGIGS_/], cost: "usage" },
  { slug: "meta-instagram", label: "Meta (Instagram / Facebook)", hosts: ["graph.facebook.com", "graph.instagram.com"], keys: [/^(META|INSTAGRAM|FACEBOOK|FB)_/], sdks: ["facebook/graph-sdk"] },
  { slug: "bluesky", label: "Bluesky", hosts: ["bsky.social", "bsky.app", "public.api.bsky.app"], keys: [/^BLUESKY_/, /^BSKY_/], sdks: ["@atproto/api", "atproto"], cost: "free" },
  { slug: "linkedin", label: "LinkedIn", hosts: ["api.linkedin.com"], keys: [/^LINKEDIN_/] },
  { slug: "tiktok", label: "TikTok API", hosts: ["open.tiktokapis.com", "open-api.tiktok.com"], keys: [/^TIKTOK_/] },
  { slug: "youtube", label: "YouTube Data API", hosts: ["youtube.googleapis.com", "www.googleapis.com/youtube", "www.googleapis.com/upload/youtube"], keys: [/^YOUTUBE_/, /^YT_/] },
  { slug: "google-play", label: "Google Play", hosts: ["androidpublisher.googleapis.com", "www.googleapis.com/androidpublisher"], keys: [/^(GOOGLE_PLAY|PLAY_)/], sdks: [] },
  { slug: "app-store", label: "App Store Connect", hosts: ["api.appstoreconnect.apple.com"], keys: [/^(ASC|APP_STORE|APPLE)_/] },
  { slug: "google-oauth", label: "Google (connexion OAuth)", hosts: ["accounts.google.com", "oauth2.googleapis.com"], keys: [/^GOOGLE_(CLIENT|OAUTH)/], sdks: ["google/apiclient", "googleapis", "google-auth-library"] },
  { slug: "google-drive", label: "Google Drive", hosts: ["www.googleapis.com/drive"], keys: [/^(GOOGLE_)?DRIVE_/] },
  { slug: "gmail", label: "Gmail", hosts: ["gmail.googleapis.com", "www.googleapis.com/gmail"], keys: [/^GMAIL_/] },
  { slug: "gemini", label: "Google Gemini", hosts: ["generativelanguage.googleapis.com"], keys: [/^GEMINI_/, /^GOOGLE_AI_/], sdks: ["@google/generative-ai", "@google/genai", "google-generativeai", "google-genai"] },
  { slug: "openai", label: "OpenAI", hosts: ["api.openai.com"], keys: [/^OPENAI_/], sdks: ["openai"], cost: "usage" },
  { slug: "anthropic", label: "Anthropic", hosts: ["api.anthropic.com"], keys: [/^ANTHROPIC_/, /^CLAUDE_API/], sdks: ["@anthropic-ai/sdk", "anthropic"], cost: "usage" },
  { slug: "mistral", label: "Mistral AI", hosts: ["api.mistral.ai"], keys: [/^MISTRAL_/], sdks: ["@mistralai/mistralai", "mistralai"], cost: "usage" },
  { slug: "elevenlabs", label: "ElevenLabs", hosts: ["api.elevenlabs.io"], keys: [/^ELEVENLABS_/, /^ELEVEN_/], sdks: ["elevenlabs"] },
  { slug: "llm", label: "llm-proxy (LLM)", hosts: ["127.0.0.1:3001", "localhost:3001", "host.docker.internal:3001"], keys: [/^LLM_/, /_LLM_(BASE_URL|API_KEY|PROVIDER|MODEL)$/] },
  { slug: "coingecko", label: "CoinGecko", hosts: ["api.coingecko.com", "pro-api.coingecko.com"], keys: [/^COINGECKO_/], sdks: ["pycoingecko"] },
  { slug: "dexscreener", label: "DexScreener", hosts: ["api.dexscreener.com", "io.dexscreener.com"], keys: [/^DEXSCREENER_/], cost: "free" },
  { slug: "geckoterminal", label: "GeckoTerminal", hosts: ["api.geckoterminal.com"], keys: [], cost: "free" },
  { slug: "coinbrain", label: "CoinBrain", hosts: ["api.coinbrain.com", "coinbrain.com"], keys: [], cost: "free" },
  { slug: "defillama", label: "DefiLlama", hosts: ["api.llama.fi", "coins.llama.fi", "yields.llama.fi"], keys: [], cost: "free" },
  { slug: "goplus", label: "GoPlus (sécurité tokens)", hosts: ["api.gopluslabs.io"], keys: [/^GOPLUS_/], cost: "free" },
  { slug: "coinmarketcap", label: "CoinMarketCap", hosts: ["pro-api.coinmarketcap.com", "api.coinmarketcap.com"], keys: [/^(CMC|COINMARKETCAP)_/] },
  { slug: "cookie-fun", label: "cookie.fun", hosts: ["api.cookie.fun", "cookie.fun"], keys: [/^COOKIE_FUN/], cost: "free" },
  { slug: "pumpfun", label: "pump.fun", hosts: ["frontend-api.pump.fun", "pump.fun"], keys: [], cost: "free" },
  { slug: "explorers", label: "Explorateurs blockchain", hosts: ["api.etherscan.io", "api.bscscan.com", "api.solscan.io", "public-api.solscan.io", "pro-api.solscan.io"], keys: [/^(ETHERSCAN|BSCSCAN|SOLSCAN)_/] },
  { slug: "pulsechain", label: "PulseChain RPC", hosts: ["rpc.pulsechain.com", "scan.pulsechain.com"], keys: [/^PULSE_/] },
  { slug: "coinzilla", label: "Coinzilla", hosts: ["coinzilla.com", "coinzilla.io"], keys: [/^COINZILLA_/] },
  { slug: "indexnow", label: "IndexNow / Bing", hosts: ["api.indexnow.org", "www.bing.com/indexnow", "ssl.bing.com/webmaster"], keys: [/^(INDEXNOW|BING)_/], cost: "free" },
  { slug: "opensea", label: "OpenSea", hosts: ["api.opensea.io"], keys: [/^OPENSEA_/] },
  { slug: "coindar", label: "Coindar", hosts: ["coindar.org"], keys: [/^COINDAR_/] },
  { slug: "openverse", label: "Openverse", hosts: ["api.openverse.org", "api.openverse.engineering"], keys: [], cost: "free" },
  { slug: "canva", label: "Canva", hosts: ["api.canva.com", "www.canva.com/api"], keys: [/^CANVA_(CLIENT|API)/] },
  { slug: "github", label: "GitHub", hosts: ["api.github.com"], keys: [/^(GITHUB|GH)_(TOKEN|PAT|APP)/], sdks: ["@octokit/rest", "octokit"] },
  { slug: "notion", label: "Notion", hosts: ["api.notion.com"], keys: [/^NOTION_/], sdks: ["@notionhq/client"] },
  { slug: "slack", label: "Slack", hosts: ["slack.com/api", "hooks.slack.com"], keys: [/^SLACK_/], sdks: ["@slack/web-api", "@slack/bolt"] },
  { slug: "discord", label: "Discord", hosts: ["discord.com/api", "discordapp.com/api"], keys: [/^DISCORD_/], sdks: ["discord.js", "discord.py"] },
  { slug: "sentry", label: "Sentry", hosts: ["sentry.io", "ingest.sentry.io"], keys: [/^SENTRY_/], sdks: ["@sentry/node", "@sentry/react", "@sentry/browser", "sentry-sdk", "sentry/sentry", "sentry_flutter"] },
  { slug: "supabase", label: "Supabase", hosts: ["supabase.co"], keys: [/^SUPABASE_/], sdks: ["@supabase/supabase-js", "supabase_flutter", "supabase"] },
  { slug: "algolia", label: "Algolia", hosts: ["algolia.net", "algolianet.com"], keys: [/^ALGOLIA_/], sdks: ["algoliasearch"] },
  { slug: "mapbox", label: "Mapbox", hosts: ["api.mapbox.com"], keys: [/^MAPBOX_/], sdks: ["mapbox-gl"] },
  { slug: "google-maps", label: "Google Maps", hosts: ["maps.googleapis.com"], keys: [/^GOOGLE_MAPS/], sdks: ["@googlemaps/js-api-loader", "google_maps_flutter"] },
  { slug: "revenuecat", label: "RevenueCat", hosts: ["api.revenuecat.com"], keys: [/^REVENUECAT_/], sdks: ["purchases_flutter", "react-native-purchases"], cost: "commission" },
  { slug: "vinted", label: "Vinted", hosts: ["www.vinted.fr/api", "vinted.fr/api"], keys: [/^VINTED_/] },
  { slug: "ebay", label: "eBay API", hosts: ["api.ebay.com"], keys: [/^EBAY_/] },
  { slug: "database", label: "Base de données", hosts: [], keys: [/^(DB|MYSQL|POSTGRES|PG|DATABASE)_(HOST|NAME|USER|PASS|PASSWORD|URL|PORT|DATABASE)$/], sdks: ["mysql2", "pg", "mysqlclient", "pymysql", "psycopg2", "psycopg2-binary", "prisma", "@prisma/client"] },
  { slug: "redis", label: "Redis", hosts: [], keys: [/^REDIS_/], sdks: ["redis", "ioredis", "predis/predis"] },
];

const NOISE_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|example\.|.*\.example\.|.*\.local$|.*\.test$|.*\.invalid$)/i;
const GENERIC_KEY = /^([A-Z][A-Z0-9]+?)_(API_KEY|APIKEY|API_TOKEN|API_SECRET|SECRET_KEY|ACCESS_TOKEN|CLIENT_ID|CLIENT_SECRET|TOKEN|API_URL|BASE_URL|WEBHOOK_SECRET)$/;
const GENERIC_SKIP = new Set(["APP", "NODE", "PORT", "HOST", "BASE", "PUBLIC", "NEXT", "VITE", "REACT", "ADMIN", "SITE", "LOCAL", "DEV", "PROD", "TEST", "NOYAU", "ACCESS", "SESSION", "JWT", "SECRET", "INTERNAL", "WEBHOOK", "AUTH", "USER", "API", "SOCIAL", "UPLOAD", "CRON", "MOBILE", "BACKEND", "FRONTEND", "SERVER", "WEB", "CLIENT", "SHARED", "ENCRYPTION", "SIGNING", "MASTER"]);

function sha(value) {
  return crypto.createHash("sha1").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function hostMatches(found, pattern) {
  const [patternHost, ...rest] = pattern.split("/");
  const patternPath = rest.length ? `/${rest.join("/")}` : "";
  const host = found.host.toLowerCase();
  if (host !== patternHost && !host.endsWith(`.${patternHost}`)) return false;
  return !patternPath || found.path.startsWith(patternPath);
}

export function providerFor({ host = null, key = null, sdk = null }, providers = PROVIDERS) {
  for (const provider of providers) {
    if (host && provider.hosts?.some((pattern) => hostMatches(host, pattern))) return provider;
    if (key && provider.keys?.some((pattern) => pattern.test(key))) return provider;
    if (sdk && provider.sdks?.includes(sdk)) return provider;
  }
  return null;
}

// Noms seulement: la capture s'arrête au « = », la valeur n'est jamais retenue.
export function envKeyNames(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && /[A-Z]/.test(match[1])) names.push(match[1]);
  }
  return [...new Set(names)];
}

const KEY_USAGE = [
  /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\$_(?:ENV|SERVER)\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /\bString\.fromEnvironment\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

export function codeEvidence(text) {
  const hosts = [];
  for (const match of String(text).matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?(\/[A-Za-z0-9._~\/-]*)?/g)) {
    hosts.push({ host: `${match[1].toLowerCase()}${match[2] || ""}`, path: match[3] || "" });
  }
  const keys = new Set();
  for (const pattern of KEY_USAGE) for (const match of String(text).matchAll(pattern)) keys.add(match[1]);
  return { hosts, keys: [...keys] };
}

export function manifestDependencies(name, text) {
  try {
    if (name === "package.json") {
      const json = JSON.parse(text);
      return Object.keys({ ...(json.dependencies || {}), ...(json.optionalDependencies || {}) });
    }
    if (name === "composer.json") return Object.keys(JSON.parse(text).require || {}).filter((dep) => dep.includes("/"));
    if (name === "pubspec.yaml") {
      const block = /(^|\n)dependencies:\s*\n((?:[ \t]+.*\n?)*)/.exec(text)?.[2] || "";
      return [...block.matchAll(/^ {2}([a-z0-9_]+):/gm)].map((match) => match[1]);
    }
    if (name === "pyproject.toml") return [...text.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)\s*[<>=~!;\[" ]/gm)].map((match) => match[1].toLowerCase());
    return text.split(/\r?\n/).map((line) => /^\s*([A-Za-z0-9_.-]+)/.exec(line.replace(/#.*/, ""))?.[1]?.toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

async function walk(root, visit, state = { count: 0, visited: 0 }) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.count >= MAX_FILES || state.visited >= MAX_VISITED) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") || entry.name === ".github") await walk(full, visit, state);
    } else if (entry.isFile()) {
      state.visited += 1;
      if (await visit(full, entry.name)) state.count += 1;
    }
  }
}

function genericSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Hôte d'API inconnu de la table: retenu seulement s'il ressemble à une API (api.x.com, x.com/api…).
function genericHost(found) {
  if (NOISE_HOSTS.test(found.host)) return null;
  const apiLike = /^api[.-]|\.api\.|^rpc\.|^graphql\./.test(found.host) || /^\/(api|v\d)\b/.test(found.path);
  if (!apiLike) return null;
  const parts = found.host.replace(/:\d+$/, "").split(".");
  const domain = parts.slice(-2).join(".");
  return { slug: genericSlug(parts.at(-2) || domain), label: domain, guessed: true };
}

export async function scanDirs(dirs, { extraEnvFiles = [], providers = PROVIDERS } = {}) {
  // Le domaine du projet lui-même (dossier « atlas.example » → atlas) n'est pas un fournisseur externe.
  const ownNames = new Set(dirs.map((dir) => genericSlug(path.basename(dir).split(".")[0])));
  const found = new Map();
  const ensure = (provider) => {
    const entry = found.get(provider.slug) || { slug: provider.slug, label: provider.label, guessed: Boolean(provider.guessed), cost: provider.cost || null, hosts: new Set(), keys: new Map(), sdks: new Map(), files: new Set() };
    found.set(provider.slug, entry);
    return entry;
  };
  const addKey = (provider, key, file) => {
    const entry = ensure(provider);
    entry.keys.set(key, new Set([...(entry.keys.get(key) || []), file]));
    entry.files.add(file);
  };
  const keyProvider = (key) => {
    const known = providerFor({ key }, providers);
    if (known) return known;
    const generic = GENERIC_KEY.exec(key);
    if (!generic || GENERIC_SKIP.has(generic[1])) return null;
    return { slug: genericSlug(generic[1]), label: generic[1].charAt(0) + generic[1].slice(1).toLowerCase(), guessed: true };
  };
  const stats = { files: 0, envFiles: 0, manifests: 0 };
  const readEnv = async (file) => {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      stats.envFiles += 1;
      for (const key of envKeyNames(await fs.readFile(file, "utf8"))) {
        const provider = keyProvider(key);
        if (provider) addKey(provider, key, file);
      }
    } catch { /* illisible */ }
  };
  for (const dir of dirs) {
    await walk(dir, async (file, name) => {
      if (SENSITIVE_FILE.test(file)) return;
      if (ENV_FILE.test(name)) return readEnv(file).then(() => true);
      if (MANIFEST_FILE.test(name)) {
        stats.manifests += 1;
        const text = await fs.readFile(file, "utf8").catch(() => "");
        for (const dep of manifestDependencies(name, text)) {
          const provider = providerFor({ sdk: dep }, providers);
          if (!provider) continue;
          const entry = ensure(provider);
          entry.sdks.set(dep, file);
          entry.files.add(file);
        }
        return true;
      }
      if (!CODE_FILE.test(name) || name.endsWith(".min.js")) return false;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) return false;
      stats.files += 1;
      const evidence = codeEvidence(await fs.readFile(file, "utf8").catch(() => ""));
      for (const host of evidence.hosts) {
        const provider = providerFor({ host }, providers) || genericHost(host);
        if (!provider) continue;
        const entry = ensure(provider);
        entry.hosts.add(host.host);
        entry.files.add(file);
      }
      for (const key of evidence.keys) {
        const provider = keyProvider(key);
        if (provider) addKey(provider, key, file);
      }
      return true;
    });
  }
  for (const file of extraEnvFiles) await readEnv(file);
  const result = {};
  for (const entry of found.values()) {
    const keys = [...entry.keys.entries()].map(([name, files]) => ({ name, files: [...files].sort() })).sort((a, b) => a.name.localeCompare(b.name));
    const files = [...entry.files].sort();
    // Un fournisseur deviné sur un seul indice faible (une URL isolée) reste hors carte.
    if (entry.guessed && ((!keys.length && files.length < 2) || ownNames.has(entry.slug))) continue;
    const provider = {
      slug: entry.slug, label: entry.label, guessed: entry.guessed, cost: entry.cost,
      hosts: [...entry.hosts].sort(), keys, sdks: [...entry.sdks.entries()].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name)),
      files: files.slice(0, 200), fileCount: files.length,
    };
    provider.hash = sha({ hosts: provider.hosts, keys: provider.keys.map((key) => key.name), sdks: provider.sdks.map((sdk) => sdk.name), files });
    result[entry.slug] = provider;
  }
  return { providers: result, stats };
}

// « A, B — scripts/canva/.env » : noms de clés regroupés par fichier.
export function keyLines(keys, rel) {
  const byFile = new Map();
  for (const key of keys) for (const file of key.files) byFile.set(file, [...(byFile.get(file) || []), key.name]);
  return [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([file, names]) => `${[...new Set(names)].join(", ")} — ${rel(file)}`);
}

export function diffInventories(applied = {}, pending = {}) {
  const added = [];
  const changed = [];
  const gone = [];
  for (const [id, item] of Object.entries(pending)) {
    const before = applied[id];
    if (!before || before.gone) added.push(id);
    else if (before.hash !== item.hash) changed.push(id);
  }
  for (const [id, item] of Object.entries(applied)) if (!pending[id] && !item.gone) gone.push(id);
  return { added, changed, gone };
}

// Plusieurs fiches par appel: preuves = noms (hôtes, clés, paquets, fichiers, commentaires masqués), jamais de valeurs.
export function sheetPrompt(items) {
  return [
    "Tu rédiges des fiches d'éléments techniques pour un fondateur non technique, en français simple.",
    "Pour chaque élément: « what » = 1 à 3 phrases concrètes sur à quoi il sert; « usedIn » = 1 à 5 endroits courts où il est utilisé (scripts, pages, tâches).",
    "N'invente rien au-delà des preuves; si c'est incertain, dis-le (« semble servir à… »). Pas de prix, pas de secrets.",
    'Réponds en JSON strict: {"items": [{"id": "...", "what": "...", "usedIn": ["..."]}]} avec exactement les id fournis.',
    "",
    ...items.flatMap((item) => [`id: ${item.id}`, `élément: ${item.label} (${item.type})`, ...item.evidence.map((line) => `- ${line}`), ""]),
  ].join("\n");
}

export class MapScanStore {
  constructor({ file, overridesFile, providersFile = null }) {
    this.file = file;
    this.overridesFile = overridesFile;
    this.providersFile = providersFile;
    this.state = { projects: {}, sheets: {} };
    this.overrides = {};
    this.writing = Promise.resolve();
  }

  async load() {
    this.state = await fs.readFile(this.file, "utf8").then(JSON.parse).catch(() => ({ projects: {}, sheets: {} }));
    this.state.projects ||= {};
    this.state.sheets ||= {};
    this.overrides = await fs.readFile(this.overridesFile, "utf8").then(JSON.parse).catch(() => ({}));
  }

  async providers() {
    if (!this.providersFile) return PROVIDERS;
    const extra = await fs.readFile(this.providersFile, "utf8").then(JSON.parse).catch(() => []);
    const compiled = (Array.isArray(extra) ? extra : []).filter((item) => item?.slug).map((item) => ({
      slug: String(item.slug), label: String(item.label || item.slug), hosts: item.hosts || [], sdks: item.sdks || [], cost: item.cost || null,
      keys: (item.keys || []).map((pattern) => { try { return new RegExp(pattern); } catch { return null; } }).filter(Boolean),
    }));
    return [...compiled, ...PROVIDERS];
  }

  project(projectId) {
    this.state.projects[projectId] ||= { applied: null, pending: null, lastRunAt: null, lastError: null };
    return this.state.projects[projectId];
  }

  async save() {
    const write = async () => {
      await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.state));
      await fs.rename(`${this.file}.tmp`, this.file);
      await fs.writeFile(`${this.overridesFile}.tmp`, JSON.stringify(this.overrides, null, 2));
      await fs.rename(`${this.overridesFile}.tmp`, this.overridesFile);
    };
    this.writing = this.writing.then(write, write);
    return this.writing;
  }
}
