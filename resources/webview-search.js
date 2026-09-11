// Shared fuzzy matcher for the Webview model lists: the Model Selector's
// search box and the Model Settings model dropdown run the SAME function
// (ruling 2026-09-11): substring first, then a subsequence walk, so 'dskv4'
// hits deepseek-v4-style ids the way the VS Code quickpick feels.
// Loaded as a plain script BEFORE modelSelector.js / serverSettings.js.
(function () {
  'use strict';

  // Case-insensitive: substring hit, or every needle char appearing in
  // order. needle must be trimmed and non-empty; haystacks arrive lowercase.
  function matches(needle, haystack) {
    if (haystack.indexOf(needle) !== -1) return true;
    var i = 0;
    for (var j = 0; j < haystack.length && i < needle.length; j++) {
      if (haystack.charAt(j) === needle.charAt(i)) i++;
    }
    return i === needle.length;
  }

  // Adapter for the Choices.js Searcher interface (reset / isEmptyIndex /
  // index / search -> {item, score, rank}[] with rank > 0 = kept), so the
  // vendored model dropdown runs matches() instead of its bundled Fuse.
  // Order-preserving: matches keep the option order the view built
  // (configured-first is deliberate there - shouldSort:false).
  function searcher() {
    var hay = [];
    return {
      reset: function () { hay = []; },
      isEmptyIndex: function () { return hay.length === 0; },
      index: function (data) {
        hay = data.map(function (c) {
          return {
            c: c,
            text: ((c.label || '') + '\u0000' + (c.value || '')).toLowerCase(),
          };
        });
      },
      search: function (needle) {
        var n = needle.trim().toLowerCase();
        var out = [];
        if (!n) return out;
        for (var i = 0; i < hay.length; i++) {
          if (matches(n, hay[i].text)) out.push({ item: hay[i].c, score: 0, rank: out.length + 1 });
        }
        return out;
      }
    };
  }

  window.VllmSearch = { matches: matches, searcher: searcher };
})();
