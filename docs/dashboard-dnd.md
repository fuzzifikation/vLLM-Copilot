# Dashboard Tree: Drag-and-Drop and Context-Menu Facts

Hard-won, empirically verified VS Code tree-view facts from building the dashboard reorder feature (2026-09-05). Live issues do NOT go here — this file is the standing reference for what the tree API can and cannot do.

## Documentation source of truth

- The `get_vscode_api` doc tool returns STALE proposal-era docs. Trust `node_modules/@types/vscode/index.d.ts` (grep it with `includeIgnoredFiles=true` — it's in `node_modules`).

## Drag-and-drop API (@types/vscode 1.128 shape)

- `TreeDragAndDropController<T>` requires BOTH `dragMimeTypes` and `dropMimeTypes`.
- `handleDrag(source, dataTransfer, token)` MUTATES the transfer — there is no return value.
- Self-drops (reordering inside the same tree) fire `handleDrop` only if `dropMimeTypes` includes the tree's own mime type: `application/vnd.code.tree.<viewidlowercase>`.
- `DataTransferItem.value` survives verbatim only for same-controller drops. Tree items are rebuilt each render, so the payload must be an **id string**, never the object.
- Wiring: `createTreeView(..., { dragAndDropController })`. Manifest contributions need a **full dev-host restart** — hot reload will not pick them up.

## What the stable API does NOT support (verified, do not re-attempt)

- No between-row drop indicator. The list widget computes `ListViewTargetSector` but `CustomTreeViewDragAndDrop.drop()` discards it before the extension's `handleDrop` is called.
- `onDragOver` is never proxied to extensions → cursor-following placeholders are impossible.
- No `canDrop`.
- **The ghost-gap-rows hack is banned** (handleDrag mutates the tree, 200 ms debounce, token cancels only on `dropEffect === 'none'`): ugly, leaky, don't.
- Hover per-row icon buttons (`"group": "inline"` + `icon`): row action bar width/sizing is owned by VS Code CSS and NOT shrinkable by extensions. Shipped once, removed 2026-09-05 as "too wide". Reordering UX = drag + context menu.

## Chosen drop semantics

- The dragged item lands **ON** the row it was dropped on: `splice(target's ORIGINAL index)` into the array with the source removed.
- Root drop = move to bottom.

## Context menu facts

- Static `arguments` in `view/item/context` menu contributions do NOT reach the command (confirmed empirically and in `treeView.ts` source): the command fires with `undefined` args — silent no-op. Don't build menu commands on contribution arguments; encode variants in separate command identities.
- Menu-contribution `title` overrides in `view/item/context` are IGNORED (tested with installed-manifest experiment, VS Code 1.128). The renderer shows the `contributes.commands` title — that is the single source of truth for context-menu labels. Short labels (Rename / Delete / Move ↑ / Move ↓) live in the command declaration; keep them out of the Command Palette via `when: false`.
- Use unicode arrows (↑ ↓) in labels, not `$(codicon)` — native Windows menus strip icon syntax.

## Shell gotcha (related, same era)

- In PowerShell, NEVER put `$(...)` in a double-quoted git commit message — PowerShell command-substitutes it. Use single quotes.
