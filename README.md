# 🚜 FS25 Twitch Sabotage

Laat Twitch-kijkers een Farming Simulator 25-stream saboteren met **bits** en **channel points**: motor uit, maaier ontkoppelen, lading kwijt, boetes, disco-lichten en nog veel meer.

```
Twitch ──(EventSub)──► Server op je VPS ──(WebSocket)──► Hulpprogramma (.exe) ──(XML-bestand)──► FS25-mod
         bits / punten   website + dashboard               bij de streamer                       actie in de game
```

Een FS25-mod kan zelf geen internetverbinding maken. Daarom draait er bij de streamer een klein hulpprogramma dat de opdrachten via een bestand in `modSettings` doorgeeft.

## Inhoud van de repo

| Map | Wat |
|---|---|
| `server/` | Node.js-server: inloggen met Twitch, dashboard, EventSub-webhooks, channel-points-beloningen, OBS-overlay |
| `companion/` | Hulpprogramma voor de streamer (wordt een Windows `.exe`) |
| `mod/FS25_TwitchSabotage/` | De FS25-mod (Lua) |
| `mod/tests/` | Test van de mod in een nagebootste FS25-omgeving |
| `deploy/` | `docker-compose.yml`, Caddy- en nginx-config voor je VPS |
| `.github/workflows/build.yml` | Testen, mod-zip + `.exe` + Docker-image bouwen, release, deploy |

## Sabotage-acties

| Actie | Woord in cheer | Standaard bits | Standaard punten |
|---|---|---|---|
| Motor uit | `!motor` | 100 | 1000 |
| Motorblokkade (motor blijft X s uit) | `!blokkade` | 300 | 3000 |
| Turbo cruise control (topsnelheid) | `!turbo` | 150 | 1500 |
| Slakkengang (cruise control op 3 km/u) | `!slak` | 100 | 1000 |
| Eruit gegooid (uit het voertuig) | `!eruit` | 250 | 2500 |
| Brandstoflek (−25%) | `!lek` | 200 | 2000 |
| Tank leeg (5% over) | `!leeg` | 1000 | 10000 |
| Schade (+20%) | `!schade` | 200 | 2000 |
| Modderbad | `!modder` | 50 | 500 |
| Werktuig ontkoppelen | `!los` | 200 | 2000 |
| Alles ontkoppelen | `!allesLos` | 500 | 5000 |
| Werktuig uit (aftakas) | `!uit` | 100 | 1000 |
| Werktuig omhoog/omlaag | `!omhoog` | 100 | 1000 |
| In-/uitklappen | `!klap` | 150 | 1500 |
| Lading kwijt (−50%) | `!lading` | 500 | 5000 |
| Lichten uit | `!donker` | 50 | 500 |
| Disco (zwaailicht + knipperen) | `!disco` | 100 | 800 |
| Toeteren | `!toet` | 25 | 300 |
| Boete (−€5000) | `!boete` | 300 | 3000 |
| Tijdsprong (120x snelheid) | `!tijd` | 300 | 3000 |
| Bericht op scherm | n.v.t. | – | 200 |
| Willekeurige sabotage | `!random` | 150 | 1500 |
| *Geldcadeau / Reparatie / Gratis tanken* | | *standaard uit* | |

Alle prijzen, cooldowns en waarden past de streamer aan in het dashboard.

**Sabotage kan alleen met bits of channel points.** Een gewoon chatbericht als `!motor` doet niets. Het woord werkt alleen *in een cheer-bericht* (bijv. `Cheer300 !boete`) om te kiezen welke actie de kijker koopt. Cheert iemand zonder woord, dan kiest de server de duurste actie die past (of een willekeurige, instelbaar).

### Slimme extra's
- **Punten terug als het niet lukt**: zit de streamer niet in een voertuig, staat de motor al uit of hangt er niets aan de trekker, dan wordt de channel-points-inwisseling automatisch geannuleerd en krijgt de kijker zijn punten terug.
- **Beloningen pauzeren** als de game niet draait (geen savegame geladen, game gepauzeerd of hulpprogramma uit).
- **Wachtrij** met minimale tijd tussen sabotages, zodat het speelbaar blijft.
- **OBS-overlay** die laat zien wie wat gedaan heeft.
- **Testknop** per actie in het dashboard (alleen voor de ingelogde streamer).

---

## Eenmalige installatie (beheerder)

### 1. Twitch-app aanmaken
1. Ga naar <https://dev.twitch.tv/console/apps> → **Register Your Application**.
2. **OAuth Redirect URL**: `https://JOUW-DOMEIN/auth/callback`
3. Categorie: *Game Integration*. Client type: *Confidential*.
4. Noteer de **Client ID** en maak een **Client Secret** aan.

### 2. VPS klaarmaken
Vereist: Docker met de compose-plugin, en een (sub)domein dat naar je VPS wijst.

```bash
sudo mkdir -p /opt/fs25-sabotage && cd /opt/fs25-sabotage
```

Kopieer `deploy/docker-compose.yml` en `deploy/.env.example` naar die map (plus `deploy/Caddyfile` als je Caddy gebruikt), en hernoem `.env.example` naar `.env`. Vul daarna `.env` in. Willekeurige geheimen maak je zo:

```bash
openssl rand -hex 32
```

De Docker-image staat op GitHub Container Registry en is standaard **privé**. Kies één van de twee:
- maak het package openbaar: GitHub → je profiel → *Packages* → `fsomod` → *Package settings* → *Change visibility* → Public, **of**
- log op de VPS één keer in met een token dat `read:packages` heeft:

```bash
docker login ghcr.io -u iitssjstn
```

#### Al een docker-compose met Nginx Proxy Manager erin?
Voeg het blok uit `deploy/compose-snippet.yml` toe aan je bestaande `docker-compose.yml`. Zet de vier `FS25_...`-geheimen in het `.env`-bestand ernaast. Zet op GitHub de variabele `VPS_APP_DIR` op de map van die compose. De deploy-workflow werkt alleen de service `fs25-sabotage` bij; je andere services blijven ongemoeid.

#### Met Nginx Proxy Manager (NPM) in een aparte compose
NPM draait zelf in Docker en kan `127.0.0.1:3000` van de host niet bereiken. Zet de app daarom in het netwerk van NPM:

1. Zoek de naam van het NPM-netwerk op (vaak `npm_default` of `nginx-proxy-manager_default`) en zet die in `.env` als `NPM_NETWORK=...`:
   ```bash
   docker network ls
   ```
2. Kopieer `deploy/docker-compose.npm.yml` naar de VPS als `docker-compose.override.yml`. `docker compose` en de deploy-workflow lezen het dan automatisch mee.
3. Start de app:
   ```bash
   docker compose up -d
   ```
4. Maak in NPM een **Proxy Host** aan:
   - **Details**: domeinnaam, scheme `http`, Forward Hostname `fs25-sabotage`, Forward Port `3000`, **Websockets Support aan** (nodig voor het hulpprogramma), Block Common Exploits aan.
   - **SSL**: *Request a new SSL Certificate*, **Force SSL** aan, HTTP/2 aan.
   - **Advanced**, voor het live logboek en de OBS-overlay:
     ```nginx
     proxy_buffering off;
     proxy_read_timeout 1h;
     ```

#### Zonder NPM
Heb je nog geen webserver, gebruik dan Caddy (regelt HTTPS automatisch):

```bash
docker compose --profile caddy up -d
```

Draait er al nginx, start dan alleen de app en gebruik `deploy/nginx.conf.example`:

```bash
docker compose up -d
```

Twitch EventSub vereist **HTTPS op poort 443**, dus de site moet bereikbaar zijn via `https://JOUW-DOMEIN`.

### 3. GitHub instellen
Ga naar **Settings → Secrets and variables → Actions**.

**Variables:**
| Naam | Waarde |
|---|---|
| `SERVER_URL` | `https://JOUW-DOMEIN`. Wordt in de `.exe` ingebouwd, zodat streamers alleen hun koppelcode hoeven te plakken. |
| `DEPLOY_ENABLED` | `true` om na elke push naar `main` automatisch te deployen |
| `VPS_APP_DIR` | optioneel, standaard `/opt/fs25-sabotage` |

**Secrets** (voor automatisch deployen):
| Naam | Waarde |
|---|---|
| `VPS_HOST` | IP of hostnaam van je VPS |
| `VPS_USER` | SSH-gebruiker (moet `docker` mogen gebruiken) |
| `VPS_SSH_KEY` | private SSH-sleutel (de publieke sleutel staat in `~/.ssh/authorized_keys` op de VPS) |
| `VPS_PORT` | optioneel, standaard 22 |

De deploy-job gebruikt de GitHub-environment `production`. Die wordt automatisch aangemaakt. Onder *Settings → Environments* kun je er een goedkeuringsstap aan toevoegen.

## Workflows

`build.yml` draait bij elke push, pull request en tag:

1. **Test server + hulpprogramma**: unit-tests en een end-to-end test (nep-Twitch-webhook → server → hulpprogramma → nagebootste mod → resultaat terug).
2. **Test FS25-mod**: Lua-syntax, `modDesc.xml` en alle acties in een nagebootste FS25-omgeving (`lua5.1`).
3. **Mod-zip** en **hulpprogramma-`.exe`** bouwen (te downloaden als artifacts bij de workflow-run).
4. **Docker-image** bouwen met de zip en `.exe` erin (de website biedt ze aan via `/downloads/`), en pushen naar `ghcr.io/iitssjstn/fsomod` (`latest`, `sha-…`, en bij tags het versienummer).
5. **Release** (alleen bij een tag `v*`): GitHub-release met de zip en de `.exe`.
6. **Deploy**: SSH naar de VPS, `docker compose pull && docker compose up -d`.

Een nieuwe versie uitbrengen:

```bash
git tag v1.0.1
```

```bash
git push origin v1.0.1
```

## Voor de streamer (3 stappen)

1. Ga naar de website en klik op **Inloggen met Twitch**.
2. Download de **mod** en zet de zip in `Documenten\My Games\FarmingSimulator2025\mods`.
3. Download het **hulpprogramma**, start het en plak de koppelcode van de website. Daarna start het automatisch met Windows.

Laad een savegame. De status op het dashboard springt dan op groen. Met de **Test**-knoppen kun je elke actie uitproberen.

> Windows SmartScreen kan waarschuwen omdat de `.exe` niet digitaal ondertekend is: kies *Meer informatie → Toch uitvoeren*.

## Lokaal ontwikkelen

```bash
cd server && npm install && npm test
```

```bash
cd server && cp .env.example .env && node --env-file=.env src/server.js
```

```bash
cd companion && npm install && node companion.js --server http://localhost:3000
```

```bash
lua5.1 mod/tests/mod_test.lua
```

## Beperkingen
- **Channel points** werken alleen voor Twitch **Affiliates/Partners** (beperking van Twitch). Bits werken ook alleen bij Affiliates/Partners, want alleen die kunnen bits ontvangen.
- **Multiplayer**: de acties werken op het voertuig van de streamer. **Boete, geldcadeau en tijdsprong** werken alleen als de streamer de **host** is. Op een dedicated server doet de mod niets.
- De mod is getest in een nagebootste FS25-omgeving tegen de echte FS25-functiesignaturen, maar **nog niet in de echte game**. Kijk bij problemen in `Documenten\My Games\FarmingSimulator2025\log.txt` naar regels met `[TwitchSabotage]`.
