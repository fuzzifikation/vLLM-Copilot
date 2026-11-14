# Upstream issues to file

Reports we owe the DeepSeek Harness team, drafted from certified behavior in our pinned composition (`@deepseek-ai/dsh` per `dsh/dsh.json`). No private hosts or paths appear below.

Filed 2026-10-06 as Discussions (the repository's issue tracker is disabled): [notice acknowledgement](https://github.com/deepseek-ai/deepseek-harness/discussions/9001), [webview cookies](https://github.com/deepseek-ai/deepseek-harness/discussions/9002).

## 1. Preview Notice acknowledgement never persists without a DeepSeek account

The first-run "Preview Notice" modal gates on `ui-settings-general.welcomeNoticeVersion` equaling the client constant (exact equality, `@deepseek-ai/dsh-client-ui-settings-models`). Clicking Continue in a profile with no DeepSeek account logs "The acknowledgement could not be saved" and sends no RPC at all; the modal reappears every boot forever. The setting itself is writable by other means (a patch-layer config row with the field set makes the notice never render), so the storage layer is fine and only the acknowledgement path is broken in the no-account composition.

Request: persist the acknowledgement through the same local settings path when no account is connected.

Current workaround: the generated overlay states `welcomeNoticeVersion` itself, pinned to the upstream constant and bumped with each dsh pin update.

## 2. Harness UI cannot be embedded in editor webviews (cookie policy)

The web server's browser session cookie is `HttpOnly; SameSite=Strict` (dsh-client-connection, `sessionCookie()`), and the `/api` transport authenticates with that cookie only. Chromium never stores or sends Strict cookies in a cross-site frame, so embedding the harness in any editor webview (VS Code extension panels, every other IDE's equivalent) shows only the 401 text. Top-level browser tabs and desktop webview shells are unaffected, which is why nobody notices upstream.

Request: support `Partitioned` (CHIPS) cookies, which are exactly designed for authenticated loopback frames on trustworthy origins like `http://127.0.0.1`, or accept the session token through a header fallback for embedded clients. Either one makes "open the harness inside the editor without its own browser chrome" possible for every editor integration, not just ours.

Current workaround: a cookie-jar reverse proxy (`src/vscode/harness/embed-proxy.ts`) carries the session server-side, so a chromeless webview panel and a bar-less `--app` window work with no upstream change; attribute rewriting remains rejected (a rewriter cannot mint what Chromium refuses to store, and it would fake the browser's policy forever after). The proxy is a workaround, not a cure: CHIPS or the header fallback lets editor integrations drop the extra local hop entirely, and the panel's URL would then need no jar, no port, and no retarget dance on restart.

## 3. No session URLs: the GUI cannot open “this session” from a link

The web GUI is a one-URL app. Across every shipped client bundle the only `history.pushState`/`replaceState` user is PDF.js inside the document-preview sidebar; the active session lives purely in memory (`dsh-client-ui-session`), and a reload always lands on the default view. Editor shells built around tabs (VS Code webviews, every IDE's equivalent, or just a browser's tab bar) cannot show one session per tab, restore a webview onto the session the user was reading, or hand someone a link to a conversation. (The `__DSH_TRANSPORT__` embedding seam proves the shell is designed to be hosted; this is the routing half of the same door.)

Request: reflect the active session in the URL (query parameter is enough, since `<base href="./">` already makes the app proxy-tolerant) and honor it at boot; deep-linking into a sub-view later would be a bonus.

Current workaround: one chromeless panel per desired view, each a full GUI over the session-multiplexing bus, with its own in-app session selection. Good enough for two or three parallel chats; it is not a substitute for real links.

## 6. Any patch content at boot permanently breaks live profile reload: every plugin toggle then fails

Version observed: dsh 0.2.2-rc.1 (latest published), Windows, plain `dsh --profile <p> --no-open` boot, standard `--from-default-profile web` template.

Reproduce (no vLLM-Copilot, no custom bundles, no `--patch`):

1. `DSH_HOME=<fresh temp dir>`; `dsh --profile p --from-default-profile web --dump-config` (creates the stock web profile; its `cordis.patch.yml` is the empty scaffold `[]`).
2. `dsh --profile p --no-open --port 0`; open the announced URL, log in with the token.
3. Open the Plugins page and toggle any experimental bundle, or call the same RPC directly: `POST /api/pluginManager/setBundleEnabled` with `{"args":{"name":"@deepseek-ai/dsh-experimental-session-search","enabled":true}}`.
4. Response: `"application":"failed","error":{"code":"operation-error","diagnostic":"dsh: profile reload requires the root Include entry"}}`. The GUI shows the toast "Could not enable: dsh: profile reload requires the root Include entry".

The write half of the toggle works: `dsh.profile.bundles` in the profile's `package.json` (or the disable row in `cordis.patch.yml`) is updated and takes effect on the next boot. Only the live reload fails, and it fails for the whole life of the process: every later toggle in that window fails the same way, so after ONE toggle plus one restart the profile is permanently un-toggleable without restarting between every two clicks. Because the profile's own patch scaffold is what makes the next boot poisoned, the plugin system consumes its own supply: a profile that has ever been toggled boots reload-broken from then on.

What we verified by bisection across three temp homes and five boots: the failure is already present on the untouched web template (step 3 fails on the FIRST toggle of the FIRST boot); a `--patch <file>` boot flag fails identically even when the file contains only `[]`; a profile patch file containing any row fails; bundle layers shipped via `dsh.bundle.patch` fail the same. One first-boot run ever applied cleanly (`application:"applied"`), and we could not stabilize the difference; every other boot of every profile shape failed. Reading `dsh-app-boot`: `mountRootInclude` records the root include via `bootstrapIncludes.set(ctx, entry)`, and the recorded entry (or its id) is missing whenever the include was created with a `patches` config, which is exactly what `prepareProfileEntries` produces from any non-empty patch set; `recomposeProfile` then throws "profile reload requires the root Include entry" at every reload.

Expected: live profile reload keeps working when the profile has patch content, since patch content is the normal state of any profile whose plugins have been toggled at all. Requested: record the root include regardless of the patches config (or otherwise make `recomposeProfile` find it), plus a regression test that toggles twice across a restart.

vLLM-Copilot posture (none of this fixes the bug, all of it reduces blast radius): the harness stopped booting with `--patch` and now writes its generated rows into the profile's own patch layer between sentinel comments (same precedence, one less poison source); it watches for the manager's writes to `cordis.patch.yml`/`package.json` while the harness runs and offers a draining restart, which is the path that actually converges. Users of the plain CLI should be told, once confirmed, to expect toggle persistence-on-restart.

---

# VS Code (microsoft/vscode), DRAFT, not filed: pending owner go

Filed against a different upstream than the two above. Filed here locally first; file on microsoft/vscode only after the owner's live go, with a fresh `Help: Report Issue` system-info dump attached.

## 4. A restored fail-load Browser tab hides every menu in the window (menus open behind the window)

Version observed: VS Code 1.140 (user build), Windows. No extension required to reproduce:

1. Open the built-in Browser and navigate to a dead loopback URL, e.g. `http://127.0.0.1:59999/x`. The tab shows the connection error page.
2. `Developer: Reload Window`. The tab restores and shows the error page again.
3. Open any menu: File, right-click context menus, quick picks. The menu opens and is not visible: it renders under the browser view, and users describe it as "menus open behind the window".
4. Close the browser tab. Menus are STILL broken. They only work again after `Developer: Reload Window`. A browser tab whose page loads successfully does NOT cause the bug at any step; it is specifically the restored fail-load view, and the damage latches: destroying the view afterwards never repairs the menus.

Measured timeline from our product's logs (extension present, but the repro above needs none): workbench restore fails the view's initial load at T+2.3 s (`main.log`: `[BrowserViewMainService] Failed to load initial URL ... ERR_CONNECTION_REFUSED`); the extension closes the tab at T+4.1 s; menus remain unreachable until window reload minutes later.

Evidence from our product (every byte here reproducible without it): a z-order recorder (`EnumWindows`, 120 ms sampling) shows no new OS window from any Code process while menus are "open": workbench menus are DOM, and the Browser tab is a native Electron child view (`contentView.addChildView` + `setBounds` in `out/mainImpl.js`, `BrowserViewMainService`), which composites above the window's web content. What latches after the fail-load restore is evidently not just the visible surface: closing the tab disposes it, yet menus keep opening beneath an invisible something until the window reloads. Sibling report microsoft/vscode#317715 (May 2026, "VSCode menu is behind editing window", closed `info-needed` because the reporter found no pattern; the pattern is a restored browser view in fail-load state).

Request: repair the menu layer when such a view is destroyed or hidden, and ideally never let a child view outrank popup-weight DOM in the first place (hide or lower the native browser view while a workbench menu, quick pick, or context menu is up, the same dance every desktop app does with child windows).

Current posture: since the chromeless panel became the default door, vLLM-Copilot no longer opens harness UIs in this browser view at all, and the poisoned-restore path is gone for its users; the `embedded` door keeps the view available, and for those users the stale-tab sweep still closes dead harness tabs at activation, which keeps later sessions clean because a closed tab is never restored. It cannot heal the one session that arrives poisoned, because no in-window action short of `Developer: Reload Window` repairs the menus. Users of any extension (or any manual localhost tab) are still exposed with no workaround at all.

## 5. The GUI markdown renderer highlights mermaid but has no diagram engine

Certified on the pinned frontend bundle: KaTeX is fully vendored (math renders), and the Shiki `langs/` set even carries the mermaid grammar, so ```mermaid blocks come out syntax-highlighted, yet no mermaid (or any diagram) engine ships in `dsh-web-frontend`, so the reader sees pretty source instead of the picture. Highlighting a language while silently lacking its renderer advertises a capability the GUI does not have.

Ask: either vendor the mermaid renderer lazily (per-block, like the langs chunks already load) or drop its grammar from the highlighter set so unsupported fences stay obviously plain. Diagrams in chat answers are first-class documentation; every competing chat surface renders them.

Current posture: documentation diagrams are authored for VS Code's own markdown preview (which ships mermaid) and for the editor, not for chat replies. The architecture figures in docs/harness.md are written this way.
