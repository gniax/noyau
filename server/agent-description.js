export async function suggestAgentDescription({ name = "", assistant = "", cwd = "", projectName = "", localLlm = null }) {
  const n = String(name || "").trim().toLowerCase();
  const a = String(assistant || "").trim().toLowerCase();
  const c = String(cwd || "").toLowerCase();
  const p = String(projectName || "").toLowerCase();

  // 1. Heuristiques spécifiques par nom, assistant ou chemin
  if (a === "shell" || n === "laptop" || n.includes("terminal")) {
    return "Terminal shell hôte Linux pour commandes directes et maintenance locale.";
  }
  if (n.includes("scraper") || c.includes("scraper")) {
    return `Scraping, extraction automatisée et ingestion de données web${projectName ? ` pour ${projectName}` : ""}.`;
  }
  if (n.includes("faker") || n.includes("mock") || c.includes("faker")) {
    return `Simulation de données, mocks et tests de charge${projectName ? ` pour ${projectName}` : ""}.`;
  }
  if (n.includes("canva") || n.includes("visuel") || n.includes("design") || a === "claude-design") {
    return `Création et génération de visuels, templates et assets graphiques${projectName ? ` pour ${projectName}` : ""}.`;
  }
  if (n.includes("marketing") || n.includes("growth") || n.includes("seo")) {
    return `Stratégie de croissance, SEO, rédaction et campagnes d'acquisition${projectName ? ` pour ${projectName}` : ""}.`;
  }
  if (n.includes("trending") || n.includes("fixer")) {
    return `Correction, recalibration et surveillance des métriques et algorithmes${projectName ? ` pour ${projectName}` : ""}.`;
  }
  if (n.includes("bot") || n.includes("telegram") || c.includes("tg-bot") || n.includes("revinted")) {
    return "Bot Telegram automatisé pour la surveillance et les alertes d'annonces.";
  }
  if (n.includes("noyau") || c.endsWith("/main")) {
    return "Développement, architecture et orchestration des agents Noyau.";
  }
  if (n.includes("cellule rouge") || c.includes("cellulerouge")) {
    return "Développement frontend et intégration pour la plateforme Cellule Rouge.";
  }
  if (n.includes("nimbus") || c.includes("nimbus")) {
    return "Développement fullstack et maintenance du site communautaire Nimbus.";
  }
  if (n.includes("atlas") || c.includes("atlas")) {
    return "Développement et maintenance de la plateforme de vote crypto Atlas.";
  }
  if (n.includes("octanix") || c.includes("octanix")) {
    return "Développement principal de la plateforme, backend et API Octanix.";
  }

  // 2. LLM local si disponible
  if (localLlm && typeof localLlm.chat === "function") {
    try {
      const prompt = `Génère une description très concise en 1 seule phrase (maximum 90 caractères) expliquant à quoi sert un agent d'IA ayant ces caractéristiques :
- Nom : ${name || assistant}
- Type : ${assistant}
- Dossier : ${cwd || "non spécifié"}
- Projet : ${projectName || "aucun"}
Réponds UNIQUEMENT la phrase de description en français, sans guillemets, sans titre.`;
      const reply = (await localLlm.chat([
        { role: "system", content: "Tu es un assistant concis qui résume le rôle d'un agent de développement en 1 seule phrase courte (max 90 caractères)." },
        { role: "user", content: prompt }
      ], { maxTokens: 60, temperature: 0.2 })).trim();
      const cleaned = reply.replace(/^["'«]+|["'»]+$/g, "").trim();
      if (cleaned.length >= 10 && cleaned.length <= 150) return cleaned;
    } catch {}
  }

  // 3. Fallback clair
  if (projectName) {
    return `Développement et maintenance du projet ${projectName}.`;
  }
  return `Agent de développement et automatisation pour ${name || assistant}.`;
}
