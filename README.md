# 🤖 Discord Bot Ultra-Complet

Bot Discord production-ready, monolithique, entièrement configurable via commandes préfixées.

## 📦 Stack Technique

| Composant | Version |
|-----------|---------|
| Runtime | Node.js 18+ |
| Librairie | discord.js v14 |
| Base de données | better-sqlite3 (SQLite) |
| Fichier principal | bot.cjs |

## 🚀 Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Créer le fichier .env
cp .env.example .env

# 3. Remplir le .env avec vos credentials
# TOKEN=votre_token_bot
# CLIENT_ID=votre_client_id
# CLIENT_SECRET=votre_client_secret

# 4. Démarrer le bot
npm start

# Ou en mode développement (avec nodemon)
npm run dev
```

## ⚙️ Configuration .env

```env
TOKEN=votre_token_bot_discord
CLIENT_ID=votre_application_client_id
CLIENT_SECRET=votre_application_client_secret
REDIRECT_URI=http://localhost:3000/auth/callback
HTTP_PORT=3000
```

## 🗄️ Base de Données

Toutes les données sont stockées dans `data.sqlite` (SQLite, créé automatiquement).

**Tables créées automatiquement :**
- `config` — Configuration par serveur
- `embeds` — Embeds personnalisés
- `announces` — Annonces
- `buttons` — Boutons interactifs
- `tickets` — Instances de tickets
- `ticket_config` — Configuration du système de tickets
- `access` — Système d'accès aux salons
- `warnings` — Avertissements de modération
- `mutes` — Mutes actifs
- `reaction_roles` — Reaction roles
- `custom_commands` — Commandes personnalisées
- `polls` — Sondages
- `poll_votes` — Votes des sondages
- `auth_buttons` — Boutons OAuth2

## 📋 Commandes Disponibles

### 🔧 Utilitaires
| Commande | Description |
|----------|-------------|
| `!ping` | Latence API + WebSocket |
| `!uptime` | Durée en ligne |
| `!botinfo` | Infos du bot |
| `!serverinfo` | Infos du serveur |
| `!userinfo [@user]` | Infos d'un utilisateur |
| `!avatar [@user]` | Avatar en grande taille |
| `!help [catégorie]` | Aide complète |

### ⚙️ Configuration
| Commande | Description |
|----------|-------------|
| `!setprefix <prefix>` | Change le préfixe |
| `!setlogchannel <#salon>` | Salon de logs |
| `!setadminrole <@role>` | Rôle admin |
| `!setmodrole <@role>` | Rôle modérateur |
| `!setmuterole <@role>` | Rôle Muted |
| `!autorole <@role\|disable>` | Autorole |
| `!setwelcome` | Configure le welcome |
| `!welcometest` | Teste le welcome |
| `!setcolor <#HEX>` | Couleur par défaut |

### 📝 Embeds
| Commande | Description |
|----------|-------------|
| `!embed create <id>` | Crée un embed |
| `!embed title <id> <titre>` | Définit le titre |
| `!embed description <id> <texte>` | Définit la description |
| `!embed color <id> <#HEX>` | Définit la couleur |
| `!embed image <id> <url>` | Image principale |
| `!embed thumbnail <id> <url>` | Miniature |
| `!embed footer <id> <texte>` | Footer |
| `!embed footericon <id> <url>` | Icône du footer |
| `!embed author <id> <nom>` | Auteur |
| `!embed authoricon <id> <url>` | Icône de l'auteur |
| `!embed authorurl <id> <url>` | URL de l'auteur |
| `!embed url <id> <url>` | URL du titre |
| `!embed timestamp <id>` | Toggle timestamp |
| `!embed addfield <id> <nom> \| <valeur>` | Ajoute un champ |
| `!embed addinlinefield <id> <nom> \| <valeur>` | Champ inline |
| `!embed clearfields <id>` | Supprime les champs |
| `!embed preview <id>` | Prévisualise |
| `!embed send <id> [#salon]` | Envoie |
| `!embed edit <id> <msg_id> [#salon]` | Édite un message |
| `!embed list` | Liste les embeds |
| `!embed delete <id>` | Supprime |
| `!embed clone <id> <nouvel_id>` | Clone |
| `!embed info <id>` | Informations |

### 📢 Annonces
| Commande | Description |
|----------|-------------|
| `!announce create <id>` | Crée une annonce |
| `!announce title <id> <titre>` | Titre |
| `!announce description <id> <texte>` | Description |
| `!announce color <id> <#HEX>` | Couleur |
| `!announce image <id> <url>` | Image |
| `!announce thumbnail <id> <url>` | Miniature |
| `!announce footer <id> <texte>` | Footer |
| `!announce timestamp <id>` | Toggle timestamp |
| `!announce addbutton <id> <btn_id>` | Attache un bouton |
| `!announce removebutton <id> <btn_id>` | Détache un bouton |
| `!announce content <id> <texte>` | Texte brut |
| `!announce addfield <id> <nom> \| <valeur>` | Champ |
| `!announce addinlinefield <id> <nom> \| <valeur>` | Champ inline |
| `!announce send <id> [#salon]` | Envoie |
| `!announce edit <id> <msg_id> [#salon]` | Édite |
| `!announce preview <id>` | Prévisualise |
| `!announce list` | Liste |
| `!announce delete <id>` | Supprime |

### 🔘 Boutons
| Commande | Description |
|----------|-------------|
| `!button create <id> <label>` | Crée un bouton |
| `!button label <id> <texte>` | Label |
| `!button style <id> <style>` | Style (primary/secondary/success/danger) |
| `!button emoji <id> <emoji>` | Emoji |
| `!button action <id> <type>` | Action (message/embed/role/ticket/access/invite/dm) |
| `!button settarget <id> <valeur>` | Cible |
| `!button setmessage <id> <texte>` | Message de réponse |
| `!button setembed <id> <embed_id>` | Embed de réponse |
| `!button ephemeral <id> <true\|false>` | Éphémère |
| `!button disable <id>` | Désactive |
| `!button enable <id>` | Active |
| `!button list` | Liste |
| `!button delete <id>` | Supprime |
| `!button info <id>` | Informations |

### 🔐 Auth OAuth2
| Commande | Description |
|----------|-------------|
| `!auth create <id> <label>` | Crée un bouton auth |
| `!auth label <id> <texte>` | Label |
| `!auth style <id> <style>` | Style |
| `!auth emoji <id> <emoji>` | Emoji |
| `!auth setguild <id> <guild_id>` | Serveur cible |
| `!auth setinvite <id> <url>` | Lien de secours |
| `!auth setsuccess <id> <texte>` | Message de succès |
| `!auth seterror <id> <texte>` | Message d'erreur |
| `!auth setalready <id> <texte>` | Message "déjà membre" |
| `!auth setdm <id> <true\|false>` | DM en cas de succès |
| `!auth setlog <id> <#salon>` | Salon de log |
| `!auth setrequirerole <id> <@role>` | Rôle requis |
| `!auth ephemeral <id> <true\|false>` | Éphémère |
| `!auth settoken <id> <token>` | Token du bot cible |
| `!auth disable <id>` | Désactive |
| `!auth enable <id>` | Active |
| `!auth list` | Liste |
| `!auth delete <id>` | Supprime |
| `!auth info <id>` | Informations |
| `!auth preview <id>` | Prévisualisation |

### 🎫 Tickets
| Commande | Description |
|----------|-------------|
| `!ticket setup` | Assistant de configuration |
| `!ticket setcategory <#catégorie>` | Catégorie |
| `!ticket setlog <#salon>` | Salon de logs |
| `!ticket setsupport <@role>` | Rôle de support |
| `!ticket panel [#salon]` | Crée le panel |
| `!ticket close [raison]` | Ferme le ticket |
| `!ticket add <@user>` | Ajoute un utilisateur |
| `!ticket remove <@user>` | Retire un utilisateur |
| `!ticket rename <nom>` | Renomme le canal |
| `!ticket list` | Liste les tickets ouverts |
| `!ticket claim` | Assigne le ticket |

### 🔑 Accès
| Commande | Description |
|----------|-------------|
| `!access create <id> <#salon>` | Crée un accès |
| `!access setrole <id> <@role>` | Rôle associé |
| `!access settype <id> <give\|toggle>` | Type |
| `!access setlabel <id> <texte>` | Label |
| `!access setstyle <id> <style>` | Style |
| `!access list` | Liste |
| `!access delete <id>` | Supprime |

### 🔨 Modération
| Commande | Description |
|----------|-------------|
| `!warn <@user> [raison]` | Avertissement |
| `!warnings <@user>` | Liste les warnings |
| `!clearwarns <@user>` | Efface les warnings |
| `!delwarn <warn_id>` | Supprime un warning |
| `!mute <@user> [durée] [raison]` | Mute (ex: 10m, 1h, 1d) |
| `!unmute <@user>` | Démute |
| `!kick <@user> [raison]` | Expulse |
| `!ban <@user> [raison]` | Bannit |
| `!unban <user_id>` | Débannit |
| `!softban <@user> [raison]` | Softban |
| `!banlist` | Liste des bans |
| `!purge <nombre>` | Supprime des messages (max 100) |
| `!slowmode <secondes>` | Slowmode (0 = désactivé) |
| `!lock [#salon]` | Verrouille un salon |
| `!unlock [#salon]` | Déverrouille un salon |

### 🎭 Rôles
| Commande | Description |
|----------|-------------|
| `!role add <@user> <@role>` | Donne un rôle |
| `!role remove <@user> <@role>` | Retire un rôle |
| `!role create <nom> [#couleur]` | Crée un rôle |
| `!role delete <@role>` | Supprime un rôle |
| `!role color <@role> <#couleur>` | Change la couleur |
| `!role info <@role>` | Informations |
| `!role members <@role>` | Liste les membres |
| `!role hoist <@role>` | Toggle affichage séparé |
| `!role mentionable <@role>` | Toggle mentionnable |
| `!reactionrole set <msg_id> <emoji> <@role>` | Reaction role |
| `!reactionrole remove <msg_id> <emoji>` | Supprime |
| `!reactionrole list` | Liste |

### ⚡ Commandes Personnalisées
| Commande | Description |
|----------|-------------|
| `!cc create <nom> <réponse>` | Crée une commande |
| `!cc edit <nom> <réponse>` | Modifie |
| `!cc delete <nom>` | Supprime |
| `!cc list` | Liste |
| `!cc info <nom>` | Informations |
| `!cc setembed <nom> <embed_id>` | Associe un embed |

### 📊 Sondages
| Commande | Description |
|----------|-------------|
| `!poll create <question>` | Sondage oui/non |
| `!poll multichoice <question> \| <opt1> \| ...` | Multi-choix |
| `!poll end <msg_id>` | Termine un sondage |

## 🔐 Permissions Discord

Le bot nécessite les permissions suivantes :
- **Intents** : Guilds, GuildMembers, GuildMessages, GuildMessageReactions, MessageContent, GuildBans, GuildModeration
- **Permissions** : Gérer les rôles, Expulser, Bannir, Gérer les salons, Envoyer des messages, Gérer les messages, Voir les salons

## 🌐 OAuth2 — Bouton d'Auth

Pour utiliser le système d'auth OAuth2 :

1. Dans le portail développeur Discord, ajouter `http://localhost:3000/auth/callback` aux **Redirects**
2. Configurer `CLIENT_ID` et `CLIENT_SECRET` dans le `.env`
3. Créer un bouton auth : `!auth create mon-bouton S'authentifier`
4. Configurer le serveur cible : `!auth setguild mon-bouton GUILD_ID`
5. Attacher le bouton à une annonce : `!announce addbutton mon-annonce mon-bouton`
6. Envoyer l'annonce : `!announce send mon-annonce #salon`

## 📝 Variables dans les Messages

Variables utilisables dans les messages personnalisés :
- `{user}` — Nom d'utilisateur
- `{mention}` — Mention de l'utilisateur
- `{server}` — Nom du serveur
- `{count}` — Nombre de membres

## 🗂️ Structure des Données

### Bouton — Actions disponibles
| Action | Description |
|--------|-------------|
| `message` | Répond avec un message texte |
| `embed` | Répond avec un embed stocké |
| `role` | Donne/retire un rôle |
| `ticket` | Ouvre un ticket |
| `access` | Donne accès à un salon |
| `invite` | Envoie un lien en DM |
| `dm` | Envoie un DM |

### Durées de Mute
| Format | Durée |
|--------|-------|
| `30s` | 30 secondes |
| `10m` | 10 minutes |
| `1h` | 1 heure |
| `1d` | 1 jour |
| `permanent` | Permanent |

## 🔧 Intents Discord

Activez ces intents dans le portail développeur :
- ✅ **SERVER MEMBERS INTENT**
- ✅ **MESSAGE CONTENT INTENT**

---

**Bot Discord Ultra-Complet** — Production Ready | discord.js v14 | SQLite
