// Applique le theme du profil avant le premier rendu: pas de flash au demarrage.
try {
  document.documentElement.dataset.theme = localStorage.getItem("noyau:theme") || "noyau";
} catch { /* stockage indisponible: theme par defaut */ }
