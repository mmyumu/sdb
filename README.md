# Plan & passage

Modélise le plan 2D d'une pièce à partir d'une photo, cale l'échelle sur une mesure
réelle, puis fait glisser un objet dedans avec gestion des collisions — pour répondre
à « est-ce que cette machine à laver passe ? ».

```bash
npm install
cp .env.example .env   # adresses de ta machine et de ton réseau — jamais versionnées
npm run dev      # http://localhost:5173 (aussi accessible depuis le téléphone sur le même wifi)
npm run tunnel   # expose le serveur en HTTPS : le chemin le plus court vers le casque
npm run cert     # variante réseau local : certificat auto-signé
npm run check    # typecheck + tests
```

Aucune dépendance à l'exécution : le redressement de perspective, la détection de
collision et la reconstruction du contour à partir d'un relevé 3D sont implémentés
dans `src/core` et `src/model`.

## Relevé au casque (Quest 3)

Le casque connaît déjà la géométrie de la pièce. Un relevé remplace **à la fois** la
photo et le recalage d'échelle : les murs arrivent en centimètres réels, sans
calibration.

Il n'y a rien à installer sur le casque : c'est la même page web, ouverte dans le
navigateur Meta Quest. Pas d'APK, pas de compte développeur, pas de mode développeur.

```bash
npm run dev      # dans un terminal
npm run tunnel   # dans un autre — affiche l'URL à ouvrir dans le casque
```

Dans le casque : ouvrir l'URL, puis **Scanner la pièce**. Le navigateur demande l'accès
aux informations d'espace, un panneau s'affiche par-dessus le passthrough, et le plan
est envoyé au PC dès qu'il est accepté.

WebXR n'est accessible qu'en **contexte sécurisé** : sans HTTPS, le bouton reste
désactivé et le dit.

La session se referme d'elle-même dès que le relevé cesse de changer. Rien ne dépend de
l'apparition du panneau affiché par-dessus le passthrough : selon le casque, `dom-overlay`
peut ne pas être accordé, et ses boutons ne sont qu'un raccourci.

`initiateRoomCapture` — la reconfiguration de l'espace par le casque — n'est **jamais**
déclenchée automatiquement : elle efface la délimitation existante, c'est donc une
décision explicite, derrière le bouton *Reconfigurer l'espace*.

### Atteindre le serveur depuis le casque

| | Tunnel (`npm run tunnel`) | Réseau local (`npm run cert`) | SSH inverse vers un Pi/VPS |
| --- | --- | --- | --- |
| Certificat | valide, aucun avertissement | auto-signé, à accepter | valide si Caddy + domaine |
| Adresse | change à chaque lancement | fixe | **fixe** |
| Traverse le NAT de WSL | oui | non, redirection à poser | oui |
| Hors du wifi de la maison | oui | non | oui, depuis un VPS |
| Exposition | URL publique le temps de la session | rien ne sort du réseau | selon l'hôte |

Le tunnel demande `cloudflared`, qui s'installe sans droits administrateur ; le script
affiche la commande s'il est absent. L'URL `…trycloudflare.com` est tirée au hasard à
chaque lancement et meurt à l'arrêt — mais tant qu'elle vit, **quiconque la connaît peut
lire et écrire les plans**. Le dépôt n'a aucune authentification.

### Ne rien taper au clavier virtuel

Saisir une URL aléatoire au clavier virtuel du casque est pénible. `npm run tunnel`
fabrique donc un lien **Web Launch**, l'endpoint par lequel Meta pousse une page vers le
navigateur du casque :

```
https://www.oculus.com/open_url/?url=<url-encodée>
```

Ouvert sur le poste — le script le fait tout seul sous WSL, `SDB_NO_OPEN=1` l'en
empêche — il envoie la page au casque, connecté au même compte Meta. On met le casque,
la page y est déjà. La cible doit être en HTTPS, ce qui est le cas du tunnel.

### Adresse fixe : tunnel SSH inverse

Un Raspberry ou un VPS joignable à une adresse stable évite le problème à la racine :
l'adresse ne changeant plus, un favori dans le casque suffit une fois pour toutes.

```bash
npm run pi                   # hôte défini par SDB_SSH_HOST
SDB_SSH_HOST=vps npm run pi  # ou n'importe quel hôte de ~/.ssh/config
```

Le script vérifie d'abord que le serveur tourne et que l'hôte distant accepte d'ouvrir
le port sur le réseau. Sans `GatewayPorts`, `-R` n'écoute que sur la boucle locale du
Pi : le tunnel a l'air de monter, et le casque n'atteint rien. À poser une fois sur
l'hôte distant :

```bash
printf 'GatewayPorts clientspecified\n' | sudo tee /etc/ssh/sshd_config.d/10-sdb-gatewayports.conf
sudo sshd -t && sudo systemctl reload ssh
```

`clientspecified` plutôt que `yes` : seuls les forwards qui demandent explicitement une
adresse de bind sont exposés, les autres restent sur la boucle locale. Le script utilise
`autossh` s'il est installé, pour remonter le tunnel après une coupure.

Reste le certificat. Deux façons :

- **Hôte sur le réseau local** : `SDB_HOST_IP` (dans `.env`) ajoute son
  adresse au certificat — la variable accepte une liste, un seul certificat couvrant
  ainsi tous les chemins d'accès. Avertissement à accepter une fois, puis favori.
- **Nom de domaine** (le vrai confort) : un Caddy sur le Pi ou le VPS termine le TLS avec
  Let's Encrypt et relaie vers le port tunnelisé. Vite peut alors rester en HTTP simple —
  supprimer `certs/` — et il faut déclarer le domaine :
  `SDB_ALLOWED_HOSTS=sdb.mondomaine.fr npm run dev`. Plus aucun avertissement, adresse
  stable, et depuis un VPS : accessible de partout.

Vite refuse les requêtes dont l'en-tête `Host` lui est inconnu : les domaines de tunnel
courants sont autorisés dans `vite.config.ts`, et `SDB_ALLOWED_HOSTS` en ajoute d'autres
(un nom de domaine à soi, plus tard).

Sur le réseau local, `npm run cert` détecte WSL, met l'adresse de Windows — et non celle
de la machine virtuelle — dans le certificat, et affiche la redirection à poser une fois
dans un PowerShell administrateur :

```powershell
netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=<ip-wsl>
New-NetFirewallRule -DisplayName "sdb 5173" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

L'adresse WSL change à chaque redémarrage, la redirection est donc à refaire.

### Le relevé brut est conservé

La scène garde le relevé tel que le casque l'a rendu (`Scene.scan`), et pas seulement
le plan qui en est tiré. La façon de le convertir continuera d'évoluer : sans ça, chaque
changement d'algorithme obligerait à remettre le casque. *Recalculer le plan* rejoue la
conversion sur le PC, et le sélecteur *Pièce du relevé* change de pièce sans rien
re-scanner. Un relevé pèse quelques dizaines de kilo-octets, et suit la scène dans
l'export JSON comme dans le dépôt.

### Plusieurs pièces dans un seul relevé

Le casque renvoie **tout son modèle d'espace** : la pièce délimitée pour jouer, la salle
de bain configurée ensuite, et le reste. Les murs sont donc chaînés en autant de
contours qu'il y a de pièces, puis une seule est retenue — **celle où se tenait le
porteur** au moment du relevé, position lue via `getViewerPose`. À défaut, la plus
grande. Le sélecteur *Pièce retenue* rend ce choix explicite et permet d'en changer sans
re-scanner. Portes et meubles sont rattachés à la pièce qui les contient.

Mesuré sur un relevé réel — un séjour et une salle de bain dans la même délimitation :
21,1 m² et 4,1 m² correctement séparés, la salle de bain retenue par la position du
porteur, et deux relevés successifs de la même pièce donnant 4,11 et 4,03 m² — soit
environ 2 % d'écart, qui est la précision réelle à attendre.

Ce qui est repris du relevé :

| Surface renvoyée par le casque | Ce qu'elle devient |
| --- | --- |
| `floor` | repère du plan, et contour quand il décrit vraiment la pièce |
| `wall` | chaînés bout à bout, les coins pris à l'intersection des droites |
| `door` | l'arête est **découpée** à la largeur réelle de la porte, qui devient traversable |
| `table`, `storage`, `couch`, `bed`… | emprise au sol, en meuble |
| `window`, `wall art`, `screen`, `ceiling` | ignorées |

Le modèle d'espace du casque ne connaît que des **quads et des boîtes** : un meuble arrondi
en ressort avec une emprise rectangulaire, plus large que la réalité. Pour « est-ce que ça
passe ? » l'erreur va dans le bon sens — elle ne peut que faire répondre non à tort, jamais
l'inverse. À retoucher au double-clic si la place est comptée.

## Partage entre appareils

IndexedDB est un stockage **local à un navigateur** : le plan relevé dans le casque n'est
pas visible depuis le PC. Le serveur de développement expose donc un dépôt commun sous
`/api/scenes`, un fichier JSON par plan dans `data/`.

Le relevé fait dans le casque y est enregistré automatiquement. Sur le PC, la section
*Plans enregistrés* liste ce qui s'y trouve — la ligne indique d'où vient l'enregistrement
et quand — et *Ouvrir* charge le plan. Aucun code à saisir, aucun appairage.

*Enregistrer* remplace l'entrée du plan ouvert ; *Enregistrer sous* en crée une nouvelle
et bascule dessus, de sorte que la précédente reste figée ; le bouton `⧉` d'une ligne la
copie sans toucher au plan ouvert. C'est le filet de sécurité avant de retoucher les
mesures : on garde le relevé intact d'un côté, on travaille sur la copie de l'autre.
Le nom se change dans le champ au-dessus des boutons.

## Le parcours

**1 · Photo.** Charge une photo où l'on voit le sol. Place les 4 coins d'un rectangle
dont tu connais les dimensions réelles — un carreau de carrelage, un pan de sol mesuré —
en tournant toujours dans le même sens, puis saisis ses deux côtés en cm.

L'application calcule l'homographie qui envoie ce quadrilatère sur le rectangle réel et
redresse toute la photo en vue de dessus. Donner les **deux** dimensions plutôt qu'une
seule est ce qui fixe le rapport d'aspect en plus de l'échelle : sans ça, la vue de
dessus serait étirée dans une direction et aucune mesure ultérieure ne pourrait le
rattraper.

**2 · Plan.** Trace le contour de la pièce par-dessus l'image redressée (Maj contraint
les angles, les sommets s'accrochent entre eux), puis l'emprise au sol de chaque meuble.
Marque les arêtes qui sont des portes ou des ouvertures : elles deviennent traversables.

*Meuble rond* trace une emprise circulaire du centre vers le bord, le diamètre suivant
le curseur — pour un lavabo, une colonne, un pied de table. Le modèle d'espace du casque
ne sait pas les représenter, et n'a même pas d'étiquette `sink` : ils sont toujours à
ajouter à la main.

Chaque emprise se redimensionne ensuite depuis sa ligne dans le panneau, **sans se
déformer** : un champ `Ø` pour un cercle, `L × P` pour les autres — saisir une dimension
met l'autre au même rapport. Le point fixe est le centre de l'englobant : le meuble
grandit sur place. Déplacer, ajouter ou retirer un sommet fait perdre la qualité de
cercle, la forme n'en étant plus un.

Les emprises issues du relevé portent une marque (`fromScan`). *Recalculer le plan* les
reconstruit et **conserve celles ajoutées à la main** — sans quoi le lavabo disparaîtrait
à chaque recalcul. Changer de pièce les retire en revanche : le repère n'est plus le même. Le modèle d'espace du casque
ne sait pas les représenter, et il n'existe même pas d'étiquette `sink` : ils sont donc
toujours à ajouter à la main. Le cercle est stocké comme un polygone, si bien que
collision et édition n'ont rien de particulier à en savoir.

*Aligner sur la grille* redresse le plan : l'orientation dominante des murs est calculée
en moyenne circulaire pondérée par leurs longueurs — un grand mur pèse plus qu'un petit —
et le plan tourne pour la rendre horizontale. Une rotation ne change aucune mesure.
L'option *équerrer les murs*, elle, **déplace des sommets** : les arêtes à moins de 8°
d'un axe y sont ramenées, les pans franchement obliques ne sont jamais touchés. D'où la
case à cocher, séparée du bouton.

En mode sélection, le contour se retouche : tirer un sommet le déplace, **double-cliquer
une arête ajoute un coin**, double-cliquer un coin le retire. Les ouvertures suivent le
découpage — couper une arête traversable garde ses deux moitiés traversables. C'est ce
qui permet de rendre au relevé du casque la niche ou le coffrage qu'il a lissés.

**3 · Échelle.** Trace un segment sur une longueur que tu as mesurée pour de vrai, saisis
sa valeur, et tout le plan se recale d'un facteur uniforme. Sert à corriger une
calibration photo approximative, ou à mettre à l'échelle un plan tracé à main levée sans
photo.

**4 · Simulation.** Ajoute un objet (gabarits d'électroménager fournis, ou sur mesure) et
fais-le glisser. Il bute sur les murs et les meubles et glisse le long au lieu de se
figer. Le badge indique en permanence `libre` ou `bloqué`. `R` tourne de 90°, la poignée
ronde tourne librement, les flèches déplacent au centimètre. Le *jeu de sécurité* élargit
l'objet de la marge que tu veux garder tout autour.

## Ce sur quoi repose la précision

- **Le redressement est géométriquement exact** — vérifié au pixel près sur une photo de
  synthèse dont la vérité terrain est connue. La précision réelle dépend donc uniquement
  de la justesse avec laquelle tu cliques les 4 coins et de la dimension que tu déclares.
  Une loupe s'affiche pendant le placement pour viser au pixel.
- **La détection de collision est balayée**, pas ponctuelle : le trajet est découpé en pas
  petits devant l'objet. Un objet ne peut donc pas franchir un mur ni un couloir trop
  étroit d'un seul bond, même en déplaçant vite la souris.
- Les objets déplacés gardent leurs dimensions réelles lors d'un recalage d'échelle
  (60 cm restent 60 cm) ; seul le plan bouge.

## Limites connues

- **Une seule photo de fond.** Le redressement porte sur un unique plan de sol. Si la
  pièce ne tient pas dans une prise de vue, trace la partie visible puis complète au
  clavier/souris en calant les longueurs avec l'outil de mesure.
- Le modèle est **purement 2D** : les hauteurs, les plinthes, les tuyaux au sol ou une
  porte qui bat dans la pièce ne sont pas représentés. Utilise le jeu de sécurité pour en
  tenir compte.
- La collision porte sur les emprises au sol tracées. Ce qui n'est pas tracé n'existe pas.
- **Le relevé du casque simplifie.** Les murs sont renvoyés comme des rectangles : une
  niche, un coffrage de tuyaux ou un mur en biais seront lissés, à la précision près du
  scan (de l'ordre de quelques centimètres). Le contour reste éditable ensuite, et
  l'outil de mesure permet de le recaler.
- Le dépôt de plans vit avec le serveur de développement. Un `dist/` servi seul garde
  l'app, mais la section *Plans enregistrés* signale alors que le serveur est absent.

## Configuration

Tout ce qui dépend de ta machine — port, hôte SSH du tunnel, adresses à mettre dans le
certificat, domaines autorisés — vit dans un fichier `.env` à la racine, **absent du
dépôt**. `.env.example` en donne le modèle commenté :

```bash
cp .env.example .env
```

Les scripts et la configuration Vite le lisent au démarrage ; une variable
d'environnement passée à la main reste prioritaire.

## Organisation

| Fichier | Rôle |
| --- | --- |
| `src/core/homography.ts` | Homographie 4 points (DLT), inversion, redressement bilinéaire |
| `src/core/geometry.ts` | Polygones, intersections, tests de recouvrement |
| `src/model/collision.ts` | Balayage, butée, glissement le long des obstacles |
| `src/model/store.ts` | État, historique, persistance IndexedDB, recalage d'échelle |
| `src/app/calibrate.ts` | Écran de placement des 4 coins |
| `src/app/render.ts` | Rendu canvas du plan |
| `src/app/tools.ts` | Outils, souris, clavier, tactile |
| `src/app/ui.ts` | Panneau latéral |
| `src/model/scan.ts` | Surfaces 3D → contour, portes découpées, emprises de meubles |
| `src/model/room.ts` | Ajout et retrait de sommets, avec report des ouvertures |
| `src/model/align.ts` | Orientation dominante, rotation, équerrage des murs |
| `src/xr/session.ts` | Session WebXR, collecte des surfaces, repère au sol |
| `src/xr/overlay.ts` | Panneau affiché dans le casque pendant le relevé |
| `src/app/plans.ts` | Sections « relevé » et « plans enregistrés » |
| `src/model/remote.ts` | Client du dépôt de plans |
| `server/scenes.ts` | Dépôt de plans, monté sur le serveur Vite |
| `scripts/tunnel.sh` | Tunnel HTTPS public (Cloudflare) |
| `scripts/pi-tunnel.sh` | Tunnel SSH inverse vers une machine à adresse fixe |
| `scripts/dev-cert.sh` | Certificat auto-signé pour le réseau local |
| `.env.example` | Modèle de configuration locale |

Le plan est sauvegardé automatiquement dans le navigateur, et exportable en JSON.
