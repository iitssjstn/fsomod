// Openbare pagina's /privacy en /terms (Engels + Nederlands).
// Het contactadres komt uit /admin (instelling contactEmail), niet uit de code.
const db = require('./db');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UPDATED = '2026-11-15';

function contact() {
  const email = (db.getSettings().contactEmail || '').trim();
  return email
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : 'the support e-mail address shown in the Twitch extension listing';
}
function contactNl() {
  const email = (db.getSettings().contactEmail || '').trim();
  return email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : 'het support-e-mailadres in de Twitch-extensielijst';
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · FS25 Twitch Sabotage</title>
<style>
  :root { --bg:#0f1512; --card:#18211c; --line:#2a372f; --text:#e8efe9; --muted:#93a399; --link:#7fd18a }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif }
  main { max-width:760px; margin:0 auto; padding:24px 16px 60px }
  h1 { font-size:24px } h2 { font-size:18px; margin-top:28px } h3 { font-size:15px; margin-top:20px }
  a { color:var(--link) } .muted { color:var(--muted) } hr { border:0; border-top:1px solid var(--line); margin:36px 0 }
  ul { padding-left:20px }
</style></head><body><main>${body}</main></body></html>`;
}

function privacy() {
  return page('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="muted">FS25 Twitch Sabotage · last updated ${UPDATED} · <a href="#nl">Nederlands</a></p>

<p>FS25 Twitch Sabotage ("the service") consists of this website, a Twitch extension, a Windows companion app and a Farming Simulator 25 mod. It lets viewers trigger in-game events on a streamer's farm with Bits and Channel Points. This policy explains which data the service processes.</p>

<h2>Viewers</h2>
<ul>
  <li><b>What we receive:</b> when you cheer, redeem a Channel Points reward or buy an action in the extension, Twitch sends us your display name, the action, the amount and, for cheers and rewards with text, your message. The extension sends us the channel ID and an anonymous (opaque) user ID from the Twitch token, and the transaction receipt.</li>
  <li><b>What we do with it:</b> we execute the action in the streamer's game and show your display name (and message, if any) in the game, in the streamer's dashboard and in the streamer's stream overlay.</li>
  <li><b>How long:</b> the dashboard log is kept in memory only (the last 100 events) and is lost when the server restarts. Transaction and event IDs are stored to prevent double execution; they do not contain your name.</li>
  <li>We do not use tracking, analytics or advertising, and we do not sell or share your data.</li>
</ul>

<h2>Streamers</h2>
<ul>
  <li><b>Twitch login:</b> your Twitch user ID, login name, display name, profile picture URL, broadcaster type and the OAuth tokens needed to read Bits and Channel Points events and to manage the rewards this service creates.</li>
  <li><b>Settings:</b> your actions, prices and options, an in-game player name, pairing keys for the Windows app and the overlay, and, if you use a rented game server, its FTP host, user name and password.</li>
  <li><b>Use:</b> only to run the service for your channel. FTP credentials are only used to exchange command files with your game server and are never shown again in the browser.</li>
  <li><b>Deletion:</b> you can delete your account at any time in the dashboard ("Account verwijderen"). This removes your data, the rewards this service created and its Twitch event subscriptions.</li>
</ul>

<h2>Cookies</h2>
<p>We only use functional cookies: a login session cookie, a short-lived cookie for the Twitch login process and, for the administrator, an admin session cookie. No tracking cookies.</p>

<h2>Third parties</h2>
<p>Data is exchanged with Twitch (Twitch API and EventSub) and, if a streamer configures it, with the streamer's own game server via FTP. Data is stored on our own server.</p>

<h2>Contact</h2>
<p>Questions or requests: ${contact()}.</p>

<hr id="nl">

<h1>Privacyverklaring</h1>
<p class="muted">Laatst bijgewerkt ${UPDATED}</p>
<p>FS25 Twitch Sabotage bestaat uit deze website, een Twitch-extensie, een Windows-programma en een mod voor Farming Simulator 25. Kijkers kunnen er met bits en channel points acties mee uitvoeren op de boerderij van een streamer.</p>
<h2>Kijkers</h2>
<ul>
  <li>Bij een cheer, een channel-points-beloning of een aankoop in de extensie ontvangen we je weergavenaam, de actie, het bedrag en eventueel je bericht. Via de extensie ook het kanaal-ID, een anoniem gebruikers-ID en het betaalbewijs.</li>
  <li>We voeren de actie uit in de game en tonen je naam (en bericht) in de game, op het dashboard van de streamer en in de overlay van de stream.</li>
  <li>Het logboek staat alleen in het geheugen (laatste 100 meldingen) en verdwijnt bij een herstart. Transactie- en meldingsnummers bewaren we om dubbele uitvoering te voorkomen; daar staat je naam niet in.</li>
  <li>Geen tracking, geen statistieken, geen reclame, en we verkopen of delen je gegevens niet.</li>
</ul>
<h2>Streamers</h2>
<ul>
  <li>Bij inloggen met Twitch: je Twitch-ID, inlognaam, weergavenaam, profielfoto-adres, accounttype en de tokens die nodig zijn voor bits- en channel-points-meldingen en het beheer van de beloningen die deze dienst aanmaakt.</li>
  <li>Je instellingen, spelernaam, koppelcodes en, bij een gehuurde server, de FTP-gegevens. FTP-gegevens worden alleen gebruikt om opdrachten met je server uit te wisselen en worden nooit meer in de browser getoond.</li>
  <li>Je kunt je account altijd verwijderen op het dashboard ("Account verwijderen"). Daarmee verdwijnen je gegevens, de beloningen en de Twitch-koppelingen.</li>
</ul>
<h2>Cookies</h2>
<p>Alleen functionele cookies: een inlogsessie, een kortdurende cookie tijdens het inloggen met Twitch en een beheerderssessie. Geen trackingcookies.</p>
<h2>Contact</h2>
<p>Vragen of verzoeken: ${contactNl()}.</p>
`);
}

function terms() {
  return page('Terms of Service', `
<h1>Terms of Service</h1>
<p class="muted">FS25 Twitch Sabotage · last updated ${UPDATED} · <a href="#nl">Nederlands</a></p>
<ol>
  <li><b>The service.</b> FS25 Twitch Sabotage lets viewers trigger entertainment events in a streamer's Farming Simulator 25 game. It is an unofficial fan project and is not affiliated with GIANTS Software or Twitch.</li>
  <li><b>Bits and Channel Points.</b> Bits are processed by Twitch under the Twitch Terms of Service. Bits cannot be refunded by us. Channel Points are refunded automatically when an action cannot be executed (for example when the streamer is not in a vehicle). The extension disables purchases while the game is not running.</li>
  <li><b>Streamers</b> decide which actions are available, their prices and settings, and are responsible for using the service in line with the Twitch Community Guidelines.</li>
  <li><b>No guarantee.</b> The service is provided "as is". Actions depend on the game, the mod, the streamer's PC or game server and Twitch, and may be delayed or fail. We are not liable for lost progress, in-game money or other damage, to the extent permitted by law.</li>
  <li><b>Fair use.</b> Do not misuse the service, attempt to bypass payments or disrupt the servers.</li>
  <li><b>Changes.</b> We may change these terms; the date above shows the latest version.</li>
  <li><b>Contact:</b> ${contact()}.</li>
</ol>

<hr id="nl">

<h1>Gebruiksvoorwaarden</h1>
<p class="muted">Laatst bijgewerkt ${UPDATED}</p>
<ol>
  <li><b>De dienst.</b> Met FS25 Twitch Sabotage kunnen kijkers acties uitvoeren in de Farming Simulator 25-game van een streamer, voor de lol. Het is een onofficieel fanproject, niet verbonden aan GIANTS Software of Twitch.</li>
  <li><b>Bits en channel points.</b> Bits worden verwerkt door Twitch onder de voorwaarden van Twitch en kunnen wij niet terugbetalen. Channel points worden automatisch teruggegeven als een actie niet uitgevoerd kan worden. De extensie blokkeert aankopen als de game niet draait.</li>
  <li><b>Streamers</b> bepalen welke acties beschikbaar zijn en tegen welke prijs, en zijn verantwoordelijk voor gebruik volgens de communityrichtlijnen van Twitch.</li>
  <li><b>Geen garantie.</b> De dienst wordt geleverd zoals hij is. Acties kunnen vertraagd zijn of mislukken. Voor zover de wet dat toestaat zijn we niet aansprakelijk voor verloren voortgang, spelgeld of andere schade.</li>
  <li><b>Eerlijk gebruik.</b> Misbruik de dienst niet en probeer betalingen niet te omzeilen.</li>
  <li><b>Contact:</b> ${contactNl()}.</li>
</ol>
`);
}

module.exports = { privacy, terms };
