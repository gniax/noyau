# Courses et applications natives — 0.138.0

## Ce qui est disponible

- Onglet Courses : 256 recettes originales, recherche par plat ou ingrédient, filtres, favoris,
  28 nouvelles familles de plats, détail photo et navigation précédente/suivante.
  Les cartes se chargent progressivement par 48 ; recherche et filtres portent
  toujours sur tout le catalogue. Les images sont des illustrations
  générées, pas des photos contractuelles du résultat. Les 224 nouvelles recettes
  ont une illustration partagée par famille, explicitement indiquée dans le détail ;
  il ne s’agit pas de 256 photos différentes. Les 32 identifiants initiaux sont conservés.
- Suggestions quotidiennes et menus de 7 ou 14 jours. Les propositions répartissent les familles pour varier les techniques, sans répéter
  une recette tant que le catalogue compatible n’est pas épuisé. Chaque plat peut être
  accepté, écarté ou remplacé. Seuls les plats acceptés alimentent les courses.
- Portions du foyer, exclusions alimentaires, budget indicatif et adresse privée
  par profil. Confirmer le foyer avant d'accepter un premier repas. Les valeurs
  initiales (2 personnes, 80 euros par période, dîners) sont modifiables et ne sont
  pas des informations personnelles déduites. Aucun numéro de rue dans le code.
- Liste agrégée, produits supplémentaires et placard : stock partiel ou case
  « déjà là / ne pas acheter », avec recalcul immédiat.
- Comparaison d'un ou deux magasins, conditionnements entiers, frais, minimums,
  remises immédiates et avantages fidélité différés séparés du montant à payer.
- Imports de relevés de prix et d'achats en CSV via les modèles visibles dans
  l'interface ; les produits fréquents proviennent d'au moins deux commandes
  importées, jamais d'un historique inventé.
- Export calendrier ICS avec heures Europe/Paris et changements d'heure ;
  rappels locaux optionnels dans l'application native, même sans réseau.

Les filtres allergènes ne remplacent pas la vérification des étiquettes,
compositions et traces de chaque produit. Les compositions inconnues sont
exclues lorsqu'une allergie est déclarée ; aucune garantie médicale n'est fournie.

## Prix et enseignes : limites explicites

Les coûts du catalogue sont des **estimations de consommation**, pas des devis
Carrefour, E.Leclerc ou Picnic. Aucun compte enseigne n'est connecté et aucune
API partenaire de création de panier n'est configurée. Il n'y a pas de lecteur
automatique universel des magazines ni de récupération automatique des commandes.

L'utilisateur peut importer des prix sourcés ou relever une page produit publique
officielle. Le lecteur JSON-LD est limité aux hôtes officiels autorisés ; il ne
contourne pas une authentification ou une protection antibot. Vérifier le bon
magasin, produit, conditionnement, date et conditions de promotion avant import.
Un prix extrait n'est pas automatiquement associé à une quantité ni à un magasin.

Les relevés expirent selon leur date de validité et leur ancienneté (48 h par
défaut). Un panier incomplet ne reçoit aucun faux total magasin. La recherche
optimise le montant à payer parmi les relevés disponibles, sur deux enseignes au
maximum ; si sa limite de calcul est atteinte, l'interface le signale. Elle ne
promet pas le prix le plus bas de tous les magasins ni des promotions absentes.
Une cagnotte future n'est jamais soustraite du montant à payer aujourd'hui.

Les minimums, frais et l'éligibilité du magasin/créneau doivent être confirmés.
Picnic est une **livraison**, pas un drive. Les conditions dépendent du lieu :
[Carrefour Courses](https://www.carrefour.fr/courses),
[recherche Carrefour au Chesnay](https://www.carrefour.fr/magasin/type/drive/le-chesnay-rocquencourt-78158),
[E.Leclerc Drive Paris](https://www.leclercdrive.fr/region-ile-de-france/paris/),
[FAQ Picnic](https://picnic.app/fr/faq).

« Préparer le transfert » produit un **brouillon**, des liens officiels et une
liste à partager. Le serveur retourne `orderCreated: false`. Aucun panier distant,
créneau, achat ou paiement n'est effectué. La commande reste à vérifier et valider
chez l'enseigne. Les connexions réelles et la signature Apple restent des tâches
ouvertes dans le suivi du projet.

## Hors ligne et synchronisation

Les recettes et images sont incluses dans l'APK. Après configuration initiale,
menus, préférences, placard et modifications restent dans le stockage local,
séparé par serveur et profil. Le stockage peut être perdu en désinstallant
l'application ou en effaçant ses données : reconnecter régulièrement pour sauver
les modifications sur le serveur. Un appareil partagé doit être protégé par le
verrouillage système ; le stockage local n'est pas un coffre matériel chiffré.

La file Courses conserve des opérations identifiées et une révision. Le serveur
applique atomiquement les opérations et déduplique les reprises. Un conflit
nécessite un choix explicite (repartir du serveur ou réappliquer les changements),
sans suppression silencieuse de la file. Le retour réseau et la reprise de
l'application déclenchent une tentative ; la synchronisation périodique fonctionne
pendant que l'écran Courses est ouvert. **Aucune synchronisation permanente d'une
application fermée n'est garantie**, ni connexion automatique au VPN par Noyau.

Sans VPN ni endpoint public configuré, les modifications attendent le retour sur
le réseau de la maison ou le VPN. Le bouton Serveur/VPN permet de reconfigurer
l'hôte HTTPS natif. Ne jamais désactiver la validation TLS : utiliser un certificat
reconnu, ou installer explicitement l'autorité privée sur l'appareil Android.

### Endpoint public optionnel et minimal

Après connexion privée, associer l'appareil dans Courses à une URL HTTPS dédiée
terminant par `/api/mobile/groceries`. Chaque jeton est aléatoire, lié à un profil,
stocké sous forme d'empreinte côté serveur, révocable et valable 90 jours. Il donne
accès aux données Courses de ce profil (adresse et habitudes comprises) et à leurs
modifications, **pas aux agents, terminaux, réglages d'administration ou checkout**.
Le secret natif est dans les préférences privées de l'application, pas dans Git.

Le backend fournit la route, mais **aucun domaine, port Internet ou proxy public
n'est publié automatiquement**. Après décision sur l'hôte et son certificat, le
proxy doit n'exposer que les deux chemins exacts suivants vers le backend HTTPS :

```nginx
# Exemple de fragment dans un serveur TLS dédié, pas une configuration complète.
# Conserver la vérification du certificat de l'amont et adapter son nom/CA.
client_max_body_size 512k;
location = /api/mobile/groceries {
    limit_except GET OPTIONS { deny all; }
    proxy_pass https://noyau_private;
    proxy_ssl_verify on;
}
location = /api/mobile/groceries/sync {
    limit_except POST OPTIONS { deny all; }
    proxy_pass https://noyau_private;
    proxy_ssl_verify on;
}
location / { return 404; }
```

Ajouter le certificat de confiance de l'amont, son SNI, les limites réseau et les
journaux sans en-tête Authorization. Tester GET sans jeton = 401, révocation = 401,
autres routes = 404. Ne pas exposer globalement `/api`. CORS est limité aux origines
natives et à l'hôte HTTPS propre ; une limitation de débit complète celle du proxy.
En cas de perte du téléphone, révoquer l'appareil depuis une session privée.

## APK, IPA, notifications et calendrier

```sh
node scripts/build-mobile.mjs android --share
node scripts/build-mobile.mjs ios --prepare-only
# Sur un Mac configuré pour la signature, avec secrets hors dépôt :
APPLE_TEAM_ID=... NOYAU_IOS_EXPORT_OPTIONS=/chemin/prive/ExportOptions.plist \
  node scripts/build-mobile.mjs ios --share
```

Android : Java 21 et SDK Android requis. Le script produit actuellement un **APK
de test signé debug**, pas une release Play Store. Il est déposé dans les Fichiers
partagés ; le manifeste privé des téléchargements pointe uniquement sur les
artefacts réellement produits. Ne pas distribuer cette clé debug comme signature
de production. Une release nécessite une clé privée stable et une filière de mise
à jour sécurisée, conservées hors dépôt.

iOS : sources Capacitor/SPM préparées, mais aucune IPA installable n'est produite
sur Linux. Mac/Xcode, équipe Apple, certificats et provisioning appropriés sont
nécessaires. Une IPA doit être signée selon sa distribution (TestFlight, ad hoc,
etc.) et ne s'installe pas simplement comme un APK. Aucune signature ni installation
sur iPhone réel n'est présumée.
Le manifeste de confidentialité inclut les raisons d'accès recommandées par
[Preferences](https://capacitorjs.com/docs/v7/apis/preferences) et
[Filesystem](https://capacitorjs.com/docs/v7/apis/filesystem) ; les déclarations
App Store finales restent à vérifier avec la distribution et les services activés.

Les rappels Courses sont des notifications **locales** programmées avec accord de
l'utilisateur. Les permissions et politiques d'économie d'énergie de l'OS peuvent
retarder leur affichage ; ne pas promettre une alarme exacte. L'ICS partagé ajoute
des événements : une nouvelle importation n'efface pas automatiquement les anciens.

Les notifications serveur natives utilisent les canaux officiels :
[Capacitor Push Notifications v7](https://capacitorjs.com/docs/v7/apis/push-notifications),
[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
Elles sont **désactivées sans configuration** :

- Android : projet Firebase pour `com.noyau.app`, fichier local
  `android/app/google-services.json` (ignoré par Git), compte de service privé via
  `NOYAU_FCM_SERVICE_ACCOUNT`. Recompiler après ajout du fichier Firebase.
- iOS : capacité Push/entitlements, provisioning correspondant,
  `NOYAU_APNS_KEY_FILE`, `NOYAU_APNS_KEY_ID`, `NOYAU_APNS_TEAM_ID` côté serveur.
  `NOYAU_APNS_SANDBOX=1` pour une signature de développement ; production sinon.
- Redémarrer le serveur après configuration, puis activer les notifications dans
  les réglages de l'application. Aucun secret ne doit être collé dans le chat.

La déconnexion native retire les données d'association locales et tente de révoquer
les appareils côté serveur. Si le serveur est inaccessible, une révocation depuis
une autre session reste nécessaire. Les autres modules restent authentifiés par
la session Noyau ; les WebSockets natifs utilisent des tickets privés de 30 s à
usage unique, liés au profil et au chemin.

Les invitations à une **nouvelle installation PWA sont retirées**. Le site desktop
et les installations existantes restent accessibles tant que le remplacement natif
n'est pas validé ; le service worker web est conservé pour cette compatibilité.

## Vérifications

`npm test`, `npm run build`, `npm run test:e2e`, puis compilation Android réelle.
Les tests couvrent catalogue, restrictions, stocks, promotions, conditionnements,
minimums, optimisation comparée à une recherche exhaustive, conflits/réessais,
isolement des profils, révocation, SSRF, calendrier DST et interface mobile.
Les tests navigateur utilisent un serveur simulé dédié, sans désactiver
l'authentification de l'application de production. Les tests physiques et l'envoi
FCM/APNs réel nécessitent les appareils et configurations mentionnés ci-dessus.
