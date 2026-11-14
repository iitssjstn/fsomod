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
| `server/` | Node.js-server: inloggen met Twitch, dashboard, EventSub-webhooks, channel-points-beloningen, OBS-overlay, Twitch-extensie (`server/extension/`) |
| `companion/` | Windows-programma voor de streamer (C#/.NET 8, WinForms): `Fs25Sabotage.App` (venster + systeemvak), `Fs25Sabotage.Core` (logica), `Fs25Sabotage.Cli` (zonder venster, voor tests) |
| `mod/FS25_TwitchSabotage/` | De FS25-mod (Lua) |
| `mod/tests/` | Test van de mod in een nagebootste FS25-omgeving |
| `deploy/` | `compose-snippet.yml` (voor een bestaande compose met NPM) en een losse `docker-compose.yml` |
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

Alle prijzen, cooldowns en waarden past de streamer aan in het dashboard. Per actie zet hij met een vinkje aan of die met **bits**, met **channel points** of met allebei gekocht kan worden.

**Sabotage kan alleen met bits of channel points.** Een gewoon chatbericht als `!motor` doet niets. Het woord werkt alleen *in een cheer-bericht* (bijv. `Cheer300 !boete`) om te kiezen welke actie de kijker koopt. Cheert iemand zonder woord, dan kiest de server de duurste actie die past (of een willekeurige, instelbaar).

### Slimme extra's
- **Punten terug als het niet lukt**: zit de streamer niet in een voertuig, staat de motor al uit of hangt er niets aan de trekker, dan wordt de channel-points-inwisseling automatisch geannuleerd en krijgt de kijker zijn punten terug.
- **Beloningen pauzeren** als de game niet draait (geen savegame geladen, game gepauzeerd of hulpprogramma uit).
- **Wachtrij** met minimale tijd tussen sabotages, zodat het speelbaar blijft.
- **OBS-overlay** die laat zien wie wat gedaan heeft.
- **Testknop** per actie in het dashboard (alleen voor de ingelogde streamer).

---

## Eenmalige installatie (beheerder)

Er staan **geen geheimen in Docker of in een `.env`-bestand**. De Twitch-keys en het beheerderswachtwoord stel je in op de beheerpagina `/admin`. Ze worden opgeslagen in het Docker-volume `fs25-sabotage-data`. Interne geheimen (sessies, EventSub) maakt de server zelf aan. Bezoekers en streamers zien deze gegevens nooit: het Twitch Client Secret gaat zelfs niet terug naar de beheerpagina.

### 1. Container toevoegen
**Al een docker-compose met Nginx Proxy Manager?** Voeg het blok uit `deploy/compose-snippet.yml` toe aan je bestaande `docker-compose.yml`. Alle services in die compose delen één netwerk, dus NPM bereikt de app via `fs25-sabotage:3000`. Een `ports:`-regel is niet nodig.

**Nog geen compose?** Gebruik `deploy/docker-compose.yml`. Die laat de app luisteren op `127.0.0.1:3000`.

Start de container:

```bash
docker compose up -d fs25-sabotage
```

De image staat op GitHub Container Registry. Als het package privé is, moet de VPS ingelogd zijn bij `ghcr.io`, net als voor je andere `ghcr.io/iitssjstn/...`-images.

### 2. Proxy Host in Nginx Proxy Manager
- **Details**: je domein, scheme `http`, Forward Hostname `fs25-sabotage`, poort `3000`, **Websockets Support aan** (nodig voor het hulpprogramma).
- **SSL**: *Request a new SSL Certificate* en **Force SSL** aan. Twitch stuurt events alleen naar `https://`.
- **Advanced**, voor het live logboek en de OBS-overlay:
  ```nginx
  proxy_buffering off;
  proxy_read_timeout 1h;
  ```

Het basisadres van de site haalt de server automatisch uit het domein dat NPM doorstuurt. Je hoeft het nergens in te stellen.

### 3. Instellen via `/admin`
1. Haal de eenmalige installatiecode op:
   ```bash
   docker logs fs25-sabotage
   ```
2. Ga naar `https://JOUW-DOMEIN/admin`, vul de code in en kies een beheerderswachtwoord.
3. Maak op <https://dev.twitch.tv/console/apps> een app aan. Gebruik als **OAuth Redirect URL** het adres dat op de beheerpagina staat (`https://JOUW-DOMEIN/auth/callback`). Kies categorie *Game Integration* en client type *Confidential*.
4. Vul de **Client ID** en het **Client Secret** in op de beheerpagina en klik op Opslaan.

Daarna kunnen streamers op de site inloggen met Twitch.

### 4. GitHub instellen (automatisch deployen, optioneel)
Ga naar **Settings → Secrets and variables → Actions**. Dit zijn alleen gegevens voor de SSH-verbinding; de app zelf heeft geen geheimen nodig.

**Variables:**
| Naam | Waarde |
|---|---|
| `DEPLOY_ENABLED` | `true` om na elke push naar `main` automatisch te deployen |
| `VPS_APP_DIR` | map waar je `docker-compose.yml` staat (standaard `/opt/fs25-sabotage`) |

**Secrets:**
| Naam | Waarde |
|---|---|
| `VPS_HOST` | IP of hostnaam van je VPS |
| `VPS_USER` | SSH-gebruiker (moet `docker` mogen gebruiken) |
| `VPS_SSH_KEY` | private SSH-sleutel (de publieke sleutel staat in `~/.ssh/authorized_keys` op de VPS) |
| `VPS_PORT` | optioneel, standaard 22 |

De deploy werkt **alleen de service `fs25-sabotage`** bij; andere services in dezelfde compose blijven ongemoeid. De deploy-job gebruikt de GitHub-environment `production`, waar je onder *Settings → Environments* een goedkeuringsstap aan kunt toevoegen.

## Workflows

`build.yml` draait bij elke push, pull request en tag:

1. **Test server + hulpprogramma**: unit-tests en een end-to-end test (nep-Twitch-webhook → server → hulpprogramma → nagebootste mod → resultaat terug).
2. **Test FS25-mod**: Lua-syntax, `modDesc.xml` en alle acties in een nagebootste FS25-omgeving (`lua5.1`).
3. **Mod-zip** en het **Windows-programma** bouwen (`dotnet publish` op een Windows-runner: één `.exe` met .NET ingebouwd; te downloaden als artifacts bij de workflow-run).
4. **Docker-image** bouwen met de zip en `.exe` erin (de website biedt ze aan via `/downloads/`), en pushen naar `ghcr.io/iitssjstn/fsomod` (`latest`, `sha-…`, en bij tags het versienummer).
5. **Release** (alleen bij een tag `v*`): GitHub-release met de zip en de `.exe`.
6. **Deploy**: SSH naar de VPS en alleen de service `fs25-sabotage` vernieuwen.

**Update-meldingen:** het dashboard en het Windows-programma melden het als de mod of het programma ouder is dan de nieuwste versie. Verhoog daarom bij elke wijziging het versienummer:
- mod: `TwitchSabotage.VERSION` in `mod/FS25_TwitchSabotage/scripts/TwitchSabotage.lua` (en `<version>` in `modDesc.xml`)
- Windows-programma: `<Version>` in `companion/Directory.Build.props`

Bij een tag `v*` krijgen beide automatisch het versienummer van de tag.

Een nieuwe versie uitbrengen:

```bash
git tag v1.0.1
```

```bash
git push origin v1.0.1
```

## Twitch-extensie: bits met één klik

Met de extensie hoeven kijkers niets te typen. Onder de stream (paneel) en in beeld (overlay, knop "🚜 Sabotage") staan knoppen zoals *Motor uit 💎 100*. De kijker klikt, Twitch toont het bevestigingsvenster voor de bits, en de sabotage gebeurt. Draait de game niet, dan zijn de knoppen grijs. Cheers met `!woord` blijven ook werken.

Instellen (eenmalig, via `/admin` op de website):
1. Maak op [dev.twitch.tv/console/extensions](https://dev.twitch.tv/console/extensions) een extensie aan met de types **Panel** en **Video - Fullscreen**.
2. **Asset Hosting**: Panel Viewer Path `panel.html` (hoogte 500), Video Fullscreen Viewer Path `video_overlay.html`, Config Path `config.html`.
3. **Capabilities**: zet bij *Allowlist for URL Fetching Domains* het adres van je site (staat op `/admin`). **Monetization**: *Bits enabled*.
4. Vul op `/admin` de **Client ID**, **Extension Secret** en **Client Secret** van de extensie in. Ze worden opgeslagen in het data-volume, nooit in Docker of een `.env`, en nooit teruggestuurd naar de browser.
5. Klik op **Koppelen & prijzen bijwerken**. De server meldt zich aan voor betalingen (`extension.bits_transaction.create`) en zet per actie een bits-product klaar. De prijzen komen van het dashboard (kolom 💎 Bits); bij elke keer opslaan worden ze bijgewerkt.
6. Download de **extensie-zip** op `/admin` (het adres van je site zit er al in) en upload hem bij *Files*. Zet de extensie op *Hosted Test*, installeer hem op het kanaal en test.
7. Werkt alles, dien hem dan in voor review bij Twitch. Zet na goedkeuring op `/admin` het vinkje **Testfase** uit en klik nogmaals op **Koppelen & prijzen bijwerken**.

Elke betaling komt twee keer binnen (vanuit het paneel en als melding van Twitch) met hetzelfde transactienummer. Hij wordt maar één keer uitgevoerd. Bits kunnen niet worden terugbetaald; daarom zijn de knoppen grijs als de game niet actief is. De bits-producten gelden voor de hele extensie, dus de prijzen volgen het kanaal waarvoor het laatst is opgeslagen. Dat past bij één streamer.

## Voor de streamer: op een gehuurde server (bijv. G-Portal)

Geen programma op de pc nodig. De website praat via FTP met de gameserver.

1. Ga naar de website en klik op **Inloggen met Twitch**.
2. Kies bij **Hoe speel je?** de optie **Op een gehuurde server**.
3. Vul de **FTP-gegevens** uit het G-Portal-webpanel in en klik op **Opslaan & testen**. De map met `mods` wordt automatisch gevonden. Het FTP-wachtwoord blijft op de website en wordt nooit teruggestuurd naar de browser.
4. Klik op **Mod op server zetten**, herstart de server via G-Portal en zet de mod aan in de savegame.
5. Vul je **spelernaam** in zoals je in FS25 heet.

Onder **Acties** kies je **wie er gesaboteerd wordt**: alleen jij, een willekeurige speler in een voertuig, of iedereen. Alle spelers op de server zien de meldingen.

> De verbinding probeert eerst versleutelde FTP (FTPS). Ondersteunt de server dat niet, dan gaat het via gewone FTP: het wachtwoord gaat dan onversleuteld van je VPS naar de gameserver.

## Voor de streamer: singleplayer of zelf hosten (3 stappen)

1. Ga naar de website en klik op **Inloggen met Twitch**.
2. Download de **mod** en zet de zip in `Documenten\My Games\FarmingSimulator2025\mods`.
3. Download het **Windows-programma**, start het en plak de koppelcode van de website (daar zit ook het serveradres in). Klik op **Koppelen**.
   - Het venster laat zien of de server en de game verbonden zijn (groen/rood).
   - Met het kruisje gaat het naar het systeemvak (rechtsonder bij de klok). Afsluiten doe je met de rechtermuisknop op het icoon.
   - **Starten met Windows** staat na het koppelen aan en kun je uitvinken. Er zijn geen beheerdersrechten nodig.

Laad een savegame. De status op het dashboard springt dan op groen. Met de **Test**-knoppen kun je elke actie uitproberen.

> Windows SmartScreen kan waarschuwen omdat de `.exe` niet digitaal ondertekend is: kies *Meer informatie → Toch uitvoeren*.

## Lokaal ontwikkelen

```bash
cd server && npm install && npm test
```

```bash
cd server && node src/server.js
```

Open daarna <http://localhost:3000/admin>; de installatiecode staat in de uitvoer van de server.

```bash
dotnet run --project companion/Fs25Sabotage.Cli -- --key FS25-...
```

```bash
lua5.1 mod/tests/mod_test.lua
```

## Beperkingen
- **Channel points** werken alleen voor Twitch **Affiliates/Partners** (beperking van Twitch). Bits werken ook alleen bij Affiliates/Partners, want alleen die kunnen bits ontvangen.
- **Multiplayer**: de mod voert opdrachten uit op de server (dedicated server, host of singleplayer). Spelers die meedoen hebben de mod automatisch via de server en krijgen meldingen in beeld. Een **tijdsprong** geldt altijd voor de hele server.
- De mod is getest in een nagebootste FS25-omgeving tegen de echte FS25-functiesignaturen, maar **nog niet in de echte game**. Kijk bij problemen in `Documenten\My Games\FarmingSimulator2025\log.txt` naar regels met `[TwitchSabotage]`.
