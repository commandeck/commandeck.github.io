// Commandeck — a deck shared as a link (K51 in the app).
//
// The link is https://commandeck.github.io/d#v1.<payload>, the payload being
// the app's export list (with Arena's About block for the name and bracket) in
// UTF-8 and base64url. The fragment never reaches the server: this page reads
// it here, asks Scryfall for the cards, and draws the deck. Nothing is stored
// anywhere but in this browser's cache of card data.
(function () {
  "use strict";

  var VERSION = "v1";
  var SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection";
  var SCRYFALL_BATCH = 75;
  var SCRYFALL_GAP_MS = 100;
  var CACHE_PREFIX = "cd-card:";
  var CACHE_MS = 24 * 60 * 60 * 1000;
  // The same affiliate link the app uses (CardStores.kt), and the same limit.
  var AFFILIATE = "https://partner.tcgplayer.com/c/7662826/1780961/21018?u={url}";
  var MASS_ENTRY = "https://www.tcgplayer.com/massentry?productline=Magic";
  var MAX_URL_LENGTH = 7000;
  var GROUPS_SHOWN = 2;

  var TYPE_ORDER = [
    ["Creature", "Creatures"], ["Planeswalker", "Planeswalkers"], ["Battle", "Battles"],
    ["Instant", "Instants"], ["Sorcery", "Sorceries"], ["Artifact", "Artifacts"],
    ["Enchantment", "Enchantments"], ["Land", "Lands"]
  ];
  var COLORS = { W: "w", U: "u", B: "b", R: "r", G: "g" };
  var HEADERS = {
    commander: "commander", commanders: "commander",
    deck: "deck", main: "deck", mainboard: "deck",
    maybeboard: "maybe", sideboard: "maybe", considering: "maybe",
    about: "about"
  };

  function $(id) { return document.getElementById(id); }

  // --- The link -------------------------------------------------------------

  function readFragment() {
    var match = /^#(v\d+)\.([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!match) return { problem: location.hash.length > 1 ? "broken" : "empty" };
    if (match[1].toLowerCase() !== VERSION) return { problem: "newer" };
    try {
      var b64 = match[2].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      var text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { text: text, payload: match[1] + "." + match[2] };
    } catch (e) {
      return { problem: "broken" };
    }
  }

  // The app's own format, read as its parser reads it (DeckListParser.kt).
  function parse(text) {
    var deck = { name: null, bracket: null, author: null, commanders: [], cards: [], maybe: [] };
    var section = "deck";
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var header = HEADERS[line.replace(/:$/, "").replace(/\s*\(\d+\)$/, "").toLowerCase()];
      if (header) { section = header; return; }
      if (section === "about") {
        var about = /^(Name|Bracket|Author)\s+(.+)$/i.exec(line);
        if (about) {
          var key = about[1].toLowerCase();
          if (key === "bracket") {
            var n = parseInt(about[2], 10);
            if (n >= 1 && n <= 5) deck.bracket = n;
          } else {
            deck[key] = about[2].trim();
          }
        }
        return;
      }
      var card = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
      var entry = card ? { qty: parseInt(card[1], 10), name: card[2].trim() } : { qty: 1, name: line };
      if (entry.qty <= 0) return;
      (section === "commander" ? deck.commanders : section === "maybe" ? deck.maybe : deck.cards).push(entry);
    });
    return deck;
  }

  // --- Scryfall, cached for a day -----------------------------------------

  function cached(name) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + name.toLowerCase());
      if (!raw) return null;
      var hit = JSON.parse(raw);
      return Date.now() - hit.at < CACHE_MS ? hit.card : null;
    } catch (e) { return null; }
  }

  function remember(name, card) {
    try {
      localStorage.setItem(CACHE_PREFIX + name.toLowerCase(), JSON.stringify({ at: Date.now(), card: card }));
    } catch (e) { /* Private mode or a full store: the page works without it. */ }
  }

  // Only what the page draws, so a hundred cards stay small in the cache.
  function slim(card) {
    var face = card.card_faces && card.card_faces[0];
    var images = card.image_uris || (face && face.image_uris) || {};
    return {
      name: card.name,
      type: card.type_line || (face && face.type_line) || "",
      identity: card.color_identity || [],
      usd: card.prices && (card.prices.usd || card.prices.usd_foil) ? parseFloat(card.prices.usd || card.prices.usd_foil) : null,
      image: images.normal || null,
      uri: card.scryfall_uri || null
    };
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function lookUp(names) {
    var found = {};
    var missing = [];
    names.forEach(function (name) {
      var hit = cached(name);
      if (hit) found[name.toLowerCase()] = hit; else missing.push(name);
    });
    var batches = [];
    for (var i = 0; i < missing.length; i += SCRYFALL_BATCH) batches.push(missing.slice(i, i + SCRYFALL_BATCH));
    return batches.reduce(function (chain, batch, index) {
      return chain.then(function () {
        return (index ? sleep(SCRYFALL_GAP_MS) : Promise.resolve()).then(function () {
          return fetch(SCRYFALL_COLLECTION, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ identifiers: batch.map(function (name) { return { name: name }; }) })
          }).then(function (response) { return response.ok ? response.json() : { data: [] }; })
            .then(function (body) {
              (body.data || []).forEach(function (card) {
                var data = slim(card);
                batch.forEach(function (asked) {
                  if (matches(asked, card.name)) { found[asked.toLowerCase()] = data; remember(asked, data); }
                });
              });
            })
            .catch(function () { /* Offline or blocked: the list still shows, without pictures or prices. */ });
        });
      });
    }, Promise.resolve()).then(function () { return found; });
  }

  // "Delver of Secrets" asks for the card Scryfall calls "Delver of Secrets // Insectile Aberration".
  function matches(asked, name) {
    var a = asked.toLowerCase();
    var n = name.toLowerCase();
    return a === n || a === n.split(" // ")[0];
  }

  // --- Drawing -------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function money(amount) {
    return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function count(entries) {
    return entries.reduce(function (sum, entry) { return sum + entry.qty; }, 0);
  }

  function groupOf(card) {
    if (!card) return "Other";
    var type = card.type.split(" // ")[0];
    for (var i = 0; i < TYPE_ORDER.length; i++) {
      if (type.indexOf(TYPE_ORDER[i][0]) !== -1) return TYPE_ORDER[i][1];
    }
    return "Other";
  }

  function isPlainBasic(entry, card) {
    var type = card ? card.type : "";
    return /^Basic\b/.test(type) && !/Snow/.test(type);
  }

  // The app's whole-deck cart: front faces, no plain basics, Mass Entry under the affiliate link.
  function buyUrl(entries, cards) {
    var lines = entries
      .filter(function (entry) { return !isPlainBasic(entry, cards[entry.name.toLowerCase()]); })
      .map(function (entry) { return entry.qty + " " + entry.name.split(" // ")[0]; });
    var prefilled = AFFILIATE.replace("{url}", encodeURIComponent(MASS_ENTRY + "&c=" + encodeURIComponent(lines.join("||"))));
    return prefilled.length <= MAX_URL_LENGTH ? prefilled : AFFILIATE.replace("{url}", encodeURIComponent(MASS_ENTRY));
  }

  function section(title, entries, cards) {
    var box = el("div", "deck-section");
    var head = el("div", "deck-section-head");
    head.appendChild(el("span", "filet"));
    head.appendChild(el("h2", null, title + " · " + count(entries)));
    head.appendChild(el("span", "filet"));
    box.appendChild(head);
    var list = el("ul", "deck-rows");
    entries
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (entry) {
        var card = cards[entry.name.toLowerCase()];
        var row = el("li", "deck-row");
        var name = el("span", "deck-row-name", (entry.qty > 1 ? entry.qty + " " : "") + entry.name);
        row.appendChild(name);
        row.appendChild(el("span", "deck-row-price", card && card.usd != null ? money(card.usd * entry.qty) : ""));
        list.appendChild(row);
      });
    box.appendChild(list);
    return box;
  }

  function draw(deck, payload, cards) {
    var inDeck = deck.commanders.concat(deck.cards);
    var lead = deck.commanders.length ? cards[deck.commanders[0].name.toLowerCase()] : null;
    var commanderNames = deck.commanders.map(function (entry) { return entry.name; });
    var name = deck.name || commanderNames.join(" + ") || "Commander deck";
    document.title = name + " — Commandeck";

    $("deck-name").textContent = name;
    $("deck-commanders").textContent = commanderNames.join(" + ") + (deck.author ? " · by " + deck.author : "");

    var cardBox = $("deck-card");
    if (lead && lead.image) {
      var img = el("img");
      img.src = lead.image;
      img.alt = lead.name;
      img.width = 244;
      img.height = 340;
      cardBox.appendChild(img);
    }

    var identity = {};
    deck.commanders.forEach(function (entry) {
      var card = cards[entry.name.toLowerCase()];
      (card ? card.identity : []).forEach(function (c) { identity[c] = true; });
    });
    var pips = $("deck-pips");
    Object.keys(COLORS).filter(function (c) { return identity[c]; }).forEach(function (c) {
      pips.appendChild(el("li", "pip " + COLORS[c]));
    });

    var total = inDeck.reduce(function (sum, entry) {
      var card = cards[entry.name.toLowerCase()];
      return sum + (card && card.usd != null ? card.usd * entry.qty : 0);
    }, 0);
    var stats = [count(inDeck) + " cards"];
    if (deck.bracket) stats.push("Bracket " + deck.bracket);
    if (total > 0) stats.push(money(total));
    $("deck-stats").textContent = stats.join(" · ");

    $("deck-open").href = "commandeck://deck#" + payload;
    $("deck-buy").href = buyUrl(inDeck, cards);

    var groups = {};
    deck.cards.forEach(function (entry) {
      var group = groupOf(cards[entry.name.toLowerCase()]);
      (groups[group] = groups[group] || []).push(entry);
    });
    var ordered = [];
    if (deck.commanders.length) ordered.push([deck.commanders.length > 1 ? "Commanders" : "Commander", deck.commanders]);
    TYPE_ORDER.map(function (t) { return t[1]; }).concat(["Other"]).forEach(function (title) {
      if (groups[title]) ordered.push([title, groups[title]]);
    });
    if (deck.maybe.length) ordered.push(["Maybeboard", deck.maybe]);

    var container = $("deck-sections");
    var nodes = ordered.map(function (pair) { return section(pair[0], pair[1], cards); });
    nodes.forEach(function (node, index) {
      if (index >= GROUPS_SHOWN) node.hidden = true;
      container.appendChild(node);
    });
    if (nodes.length > GROUPS_SHOWN) {
      var more = $("show-all");
      more.textContent = "Show all " + count(inDeck) + " cards";
      more.hidden = false;
      more.addEventListener("click", function () {
        nodes.forEach(function (node) { node.hidden = false; });
        more.hidden = true;
      });
    }
    $("deck").hidden = false;
  }

  function problem(kind) {
    var copy = {
      empty: ["No deck in this link", "A shared deck link carries the list after the # sign. Ask for the link again, or open it in Commandeck."],
      broken: ["This link is incomplete", "Part of the deck was lost on the way. Ask for the link again, or open it in Commandeck."],
      newer: ["This link is from a newer Commandeck", "Open it in an updated Commandeck to see the deck."]
    }[kind];
    $("problem-title").textContent = copy[0];
    $("problem-text").textContent = copy[1];
    $("deck-problem").hidden = false;
  }

  function start() {
    var link = readFragment();
    if (link.problem) { problem(link.problem); return; }
    var deck = parse(link.text);
    var names = deck.commanders.concat(deck.cards, deck.maybe).map(function (entry) { return entry.name; });
    if (!names.length) { problem("broken"); return; }
    lookUp(names).then(function (cards) { draw(deck, link.payload, cards); });
  }

  window.addEventListener("hashchange", function () { location.reload(); });
  start();
})();
