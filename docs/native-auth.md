# Connexion biométrique et téléchargements — 0.139.0

## Utilisation

1. Installer l'APK de test disponible dans **Réglages → Applications Noyau** ou
   dans les Fichiers partagés. Se connecter une première fois au serveur HTTPS
   avec le mot de passe du profil (ou la clé d'accès autorisée).
2. Dans **Réglages → Connexion Face ID / empreinte**, choisir **Activer**, confirmer
   le mot de passe, puis accepter la vérification du système sur le téléphone.
3. Aux ouvertures suivantes et au retour dans l'application, le système propose
   automatiquement Face ID / Touch ID sur iPhone, ou la biométrie forte disponible
   sur Android (notamment l'empreinte sur les Samsung compatibles).
4. Une annulation laisse l'application verrouillée, sans boucle de sollicitations.
   On peut réessayer ou désactiver cette association et revenir au mot de passe.

Il faut une biométrie déjà configurée dans les réglages du téléphone. La caméra
web n'est pas utilisée ; cette fonction n'est pas une imitation Face ID dans le
navigateur. Les reconnaissances faciales Android de classe faible ne sont pas
acceptées. Un code PIN du téléphone ne remplace pas silencieusement la biométrie :
le secours est le mot de passe Noyau.

L'activation est volontaire, par serveur HTTPS et profil. Le mot de passe n'est
jamais enregistré par ce mécanisme. Empreintes, visage et gabarits biométriques ne
quittent pas les services biométriques du système et ne sont jamais transmis au
serveur Noyau.

## Protections

- Android : jeton aléatoire chiffré en AES-GCM ; clé non exportable Android Keystore
  exigeant une authentification forte **à chaque usage**, déverrouillée avec le
  `CryptoObject` de `BiometricPrompt`. L'ajout d'une empreinte invalide la clé sur
  les versions prises en charge. Aucun secret dans les préférences en clair.
- iOS : jeton dans Keychain avec `biometryCurrentSet` et
  `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, sans synchronisation iCloud ni
  transfert sur un autre appareil. Changer les biométries enregistrées invalide
  l'accès au secret. `NSFaceIDUsageDescription` et le pont Capacitor sont déclarés.
- Serveur : empreinte SHA-256 du jeton uniquement, durée maximale de 30 jours,
  dix associations actives par profil, confirmation du mot de passe à l'activation,
  limitation des tentatives et révocation par appareil. Un changement de mot de
  passe, de clé serveur ou la suppression du profil invalide les associations.
- Après vérification système, une session Noyau HTTPS de deux heures est créée,
  avec cookie HttpOnly, Secure et SameSite=Strict. Elle est liée à l'appareil ; la
  révocation bloque aussi ses prochaines requêtes HTTP authentifiées. Les cookies
  de connexion classique restent compatibles. Aucun jeton n'est placé dans une URL.
- Les métadonnées locales (activation, nom, échéance et identifiant) ne contiennent
  ni mot de passe ni jeton. Le secret ne revient en mémoire JavaScript qu'après
  la vérification native, pour établir la session, jamais dans localStorage.
- L'interface est masquée avant l'authentification à froid et lorsque l'application
  reçoit le signal de passage en arrière-plan. Une éventuelle vignette système
  capturée avant ce signal doit être vérifiée sur chaque appareil.
  Cela ne constitue pas une protection contre un téléphone rooté/jailbreaké, une
  compromission de l'application ou une extraction des données locales. L'APK est
  un build **debug de test**, pas une version de production durcie.

Sans réseau/VPN, la vérification biométrique peut ouvrir uniquement les données
déjà en cache, jusqu'à l'échéance de l'association. Aucun accès au serveur n'est
créé sans réponse valide. Un refus HTTP (401/403/429/500) ne devient jamais un
contournement hors ligne. Une révocation distante ne peut pas être connue pendant
une coupure réseau ; elle sera contrôlée à la prochaine connexion.

Désactiver l'association locale ou choisir le secours mot de passe supprime son
secret et demande une nouvelle connexion classique. La déconnexion essaie de
révoquer les capacités Courses/push avant le jeton biométrique, puis efface la
session locale. Si le serveur n'est pas joignable, révoquer également l'appareil
depuis une autre session quand possible. Les connexions déjà ouvertes ne sont pas
une preuve de révocation instantanée de tous les transports.

## Téléchargements et état réel

Réglages affiche séparément APK Android et IPA iPhone/iPad, leur version, la nature
debug/signée et leur disponibilité. Les fichiers proviennent du manifeste privé
des builds effectivement produits, pas d'une URL APK codée en dur. Dans l'app,
l'ouverture du navigateur utilise un lien de téléchargement limité à ce fichier,
sans transmettre la session Noyau au navigateur externe.

L'APK Android est compilé et déposé dans les Fichiers partagés. Les sources Face ID
et iOS sont préparées ; **aucune compilation/signature iOS ni vérification sur
iPhone réel n'est présumée**. L'IPA reste indisponible sans Mac/Xcode, équipe Apple,
certificats et provisioning. Une IPA n'est pas installable comme un APK ; sa
distribution dépend du mode de signature Apple choisi. Aucun nouveau bouton PWA.

Les tests automatisés couvrent stockage serveur sans secret, isolement, expiration,
révocation, changement de mot de passe, limitation des tentatives, cookies liés,
annulation système simulée, secours hors ligne et affichage des téléchargements.
Les tests physiques Face ID/empreinte et les politiques de chaque OS restent à
valider sur les appareils du fondateur avant de qualifier la version de production.

Références : [Android BiometricPrompt et CryptoObject](https://developer.android.com/identity/sign-in/biometric-auth),
[Apple Keychain et biométrie](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id),
[Apple biometryCurrentSet](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset),
[pont natif Capacitor Android](https://capacitorjs.com/docs/v7/android/custom-code),
[pont natif Capacitor iOS](https://capacitorjs.com/docs/v7/ios/custom-code).
