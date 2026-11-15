// FS25 Twitch Sabotage: Twitch-extensie (paneel en overlay).
// Kijkers kiezen een sabotage en betalen met bits via het venster van Twitch zelf.
(function () {
  'use strict';
  var EBS = '__EBS_URL__';
  var ext = window.Twitch && window.Twitch.ext;
  var mode = document.body.getAttribute('data-mode');
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  var token = null;
  var menu = null;          // { linked, gameActive, actions: [{ sku, label, desc, bits }] }
  var products = {};        // sku -> product van Twitch (echte prijs)
  var productsError = false;
  var bitsEnabled = true;
  var busy = false;
  var toastTimer = null;
  var countdownTimer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function toast(text, isError) {
    toastEl.textContent = text;
    toastEl.className = 'toast' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'toast hidden'; }, 5000);
  }

  // Melding die aftelt tot de sabotage start, zodat de kijker naar de stream kan scrollen.
  function countdown(name) {
    var secs = menu && menu.delaySeconds != null ? menu.delaySeconds : 5;
    clearInterval(countdownTimer);
    if (secs <= 0) { toast('Bedankt. ' + name + ' wordt uitgevoerd.'); return; }
    var scroll = mode === 'panel' ? ' Scroll naar de stream!' : '';
    function tick() {
      if (secs <= 0) {
        clearInterval(countdownTimer);
        toast(name + ' gaat nu af. Bedankt!');
        return;
      }
      toastEl.textContent = 'Bedankt. ' + name + ' start over ' + secs + (secs === 1 ? ' seconde.' : ' seconden.') + scroll;
      toastEl.className = 'toast';
      clearTimeout(toastTimer);
      secs--;
    }
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function render() {
    app.textContent = '';
    var h = el('h1', null, 'Saboteer de boer');
    app.appendChild(h);

    if (!ext) { app.appendChild(el('p', 'muted', 'Deze extensie werkt alleen op Twitch.')); return; }
    if (!menu) { app.appendChild(el('p', 'muted', 'Laden…')); return; }
    if (!menu.linked) { app.appendChild(el('p', 'muted', 'De streamer heeft Twitch Sabotage nog niet ingesteld.')); return; }

    app.appendChild(el('p', 'muted', 'Kies een actie en betaal met bits. Een paar seconden later gebeurt het in de game.'));

    var state;
    if (!bitsEnabled) state = el('div', 'state off', 'Bits zijn op dit kanaal (of in deze app) niet beschikbaar.');
    else if (productsError) state = el('div', 'state off', 'Bits kunnen hier niet gebruikt worden. Probeer het op twitch.tv in je browser.');
    else if (!menu.gameActive) state = el('div', 'state off', 'De game draait nu niet. Probeer het straks opnieuw.');
    else state = el('div', 'state', 'De game draait. Kies een actie.');
    app.appendChild(state);

    var list = el('div', 'list');
    var shown = 0;
    menu.actions.forEach(function (a) {
      var p = products[a.sku];
      if (!p && !productsError) return; // product (nog) niet bij Twitch: niet tonen
      shown++;
      var cost = p && p.cost ? p.cost.amount : a.bits;
      var btn = el('button', 'item');
      btn.type = 'button';
      var txt = el('span', 'txt');
      txt.appendChild(el('span', 'name', a.label));
      txt.appendChild(el('span', 'desc', a.desc));
      btn.appendChild(txt);
      btn.appendChild(el('span', 'cost', cost + ' bits'));
      btn.disabled = busy || !bitsEnabled || productsError || !menu.gameActive || !p;
      btn.addEventListener('mouseenter', function () { try { ext.bits.showBitsBalance(); } catch (e) {} });
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        busy = true;
        render();
        ext.bits.useBits(a.sku);
      });
      list.appendChild(btn);
    });
    if (!shown) list.appendChild(el('p', 'muted', 'Er zijn nu geen acties beschikbaar.'));
    app.appendChild(list);
  }

  function loadMenu() {
    if (!token) return;
    fetch(EBS + '/ext/menu', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (m) { menu = m; render(); })
      .catch(function () { if (!menu) { menu = { linked: true, gameActive: false, actions: [] }; render(); } });
  }

  function loadProducts() {
    ext.bits.getProducts().then(function (list) {
      products = {};
      list.forEach(function (p) { products[p.sku] = p; });
      productsError = false;
      render();
    }).catch(function () { productsError = true; render(); });
  }

  if (mode === 'overlay') {
    document.getElementById('toggle').addEventListener('click', function () { app.classList.toggle('hidden'); });
  }

  if (!ext) { render(); return; }

  bitsEnabled = !!(ext.features && ext.features.isBitsEnabled);
  if (ext.features && ext.features.onChanged) {
    ext.features.onChanged(function (changed) {
      if (changed.indexOf('isBitsEnabled') >= 0) { bitsEnabled = !!ext.features.isBitsEnabled; render(); }
    });
  }

  ext.onAuthorized(function (auth) {
    var first = !token;
    token = auth.token;
    if (first) { loadMenu(); loadProducts(); }
  });

  ext.bits.onTransactionComplete(function (tx) {
    var name = tx.product && tx.product.displayName ? tx.product.displayName : 'Sabotage';
    if (tx.initiator !== 'current_user') {
      if (mode === 'overlay') toast((tx.displayName || 'Iemand') + ': ' + name);
      return;
    }
    busy = false;
    render();
    fetch(EBS + '/ext/transaction', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: tx.transactionReceipt, displayName: tx.displayName })
    }).catch(function () { /* Twitch meldt de betaling ook rechtstreeks aan de server */ });
    countdown(name);
  });

  ext.bits.onTransactionCancelled(function () { busy = false; render(); });

  setInterval(loadMenu, 15000);
  render();
})();
