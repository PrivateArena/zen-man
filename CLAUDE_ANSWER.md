This is a meaty technical topic. I'll write comprehensive coverage of all 5 features — DOpus behavior, user workflows, and web-based architecture — and pair it with an interactive reference widget.Here's the full breakdown across all five features. The widget above is navigable — click each feature in the left sidebar to jump to its DOpus behavior, user workflow, and zen-man architecture.

---

## 1. Flat View (Mixed / Mixed No Folders / Grouped)

**DOpus behavior in depth.** Flat View is a virtual presentation layer over the real file system tree. The lister doesn't change where files live — it changes how they're *displayed*. In **Mixed** mode, `fs.WalkDir`-style traversal produces a combined stream of files and directories sorted together as if they all lived at root level. A "relative path" column fills in the structural context. In **Mixed No Folders**, that stream suppresses directory entries, leaving a pure leaf-file listing — ideal for mass operations like selecting all `.log` files scattered across a project. In **Grouped** mode, DOpus inserts a collapsible separator row for each immediate child folder, then lists that folder's contents below it. This is architecturally different from the other two: it's a two-level virtual tree, not a flat array.

**Key implementation traps for zen-man.** The selection model is the hardest part. Since the visual list is virtual but operations are real, every selected row must carry a canonical absolute path — never a display-list index. Drag/drop from flat view must resolve the real parent directory, not drop into the flat view root. For grouped mode, collapsing a group must only affect the display state (a `Set<string>` of collapsed group IDs), never filter `allEntries`. Virtual list scrolling (e.g. a `<canvas>`-based renderer or a windowed `<div>` pool) is essentially mandatory once you have 10k+ files from a deep subtree.

---

## 2. Context-Aware Folder Formats

**DOpus behavior in depth.** This is DOpus's equivalent of a CSS cascade for the file listing. Formats are evaluated in priority order on every navigation event. The evaluation chain is: locked per-folder format → exact path match → longest-matching path glob → content-type heuristic → default format. The content heuristic is lightweight: DOpus counts extensions in the directory listing (not a full MIME scan) and applies thresholds per category. A format specifies columns, sort, group-by, view mode (details/large icons/thumbnails), and whether the format is "sticky" (resists being overridden by user column drags).

**Key implementation traps for zen-man.** The glob evaluation order matters — a user with both `D:\Work\*` and `D:\Work\Projects\*` expects the more specific rule to win. Sort by specificity (segment depth of the pattern) before evaluating. The content probe should be capped (sample 200 entries max) to avoid latency on large network folders. Storing formats as a user-editable JSON array means you can expose a simple drag-to-reorder priority UI. When a format switch fires, animate column adds/removes rather than doing a hard re-render — the visual change cues the user that the context was detected.

---

## 3. Advanced Rename Tool

**DOpus behavior in depth.** The rename dialog is modal and operates on the current selection. The architecture is fundamentally a pipeline: the input file list flows through the rename spec (regex substitution, counter insertion, case transform, prefix/suffix, extension handling) to produce a proposed output list. Each stage is independently configurable. The preview table is the UI's source of truth — you only click "Rename" when all rows show green. Errors caught pre-flight include duplicate output names, names with illegal characters, names that collide with existing files outside the selection, and regex parse errors.

The scripting mode passes each filename (plus file metadata: size, date, EXIF if available) to a JScript function that returns the new name. This makes things like "rename photos to their EXIF date" trivially possible. DOpus also supports a "Rename using clipboard" mode and can chain multiple rename passes in a single operation.

**Key implementation traps for zen-man.** The preview round-trip latency must be under ~100ms to feel real-time. For pure regex/wildcard renames, do the preview entirely in the browser — <code>new RegExp()</code> in JS is fast and avoids a server round-trip. Reserve the backend call for scripting mode (run `goja` or `otto` for sandboxed JS on the Go side). Counter tokens need a stable ordering: the rename order should be deterministic (sort by current name before assigning counters), and users need control over start value and step. Undo should write a reverse mapping to a sidecar JSON file, not rely on OS-level undo.

---

## 4. Find / Filter Bar

**DOpus behavior in depth.** The critical design decision DOpus made is that the Filter Bar filters the *in-memory listing*, not the file system. This makes it instantaneous and requires zero disk I/O. It is not a search tool — it's a lens over what's already loaded. The implementation is a client-side predicate applied to the current `allEntries[]` array, producing a `filteredEntries[]` array. The underlying `allEntries` is never mutated; the filter state is a separate reactive variable.

**Key implementation traps for zen-man.** Glob-to-regex conversion has edge cases: `*` should not match path separators (so `*.jpg` should not match `subdir/foo.jpg`), `?` matches exactly one character but not a separator. The filter should also handle extension-only inputs gracefully — typing `jpg` should optionally match `.jpg` extensions even without the dot. For virtual lists with 50k+ entries, move the filter loop into a Web Worker to keep the main thread at 60fps. The match-count indicator (`14 of 203`) requires keeping `allEntries.length` available even when only `filteredEntries` is rendered. Keyboard UX is paramount: the trigger key (configurable, e.g. `/` or `*`) should focus the bar without losing the current selection.

---

## 5. Button / Command Editor

**DOpus behavior in depth.** Every actionable surface in DOpus — toolbar button, menu item, hotkey, file type action — is backed by the same command body format. The command body is a sequential script where lines execute top-to-bottom. DOpus's internal command language (`Copy`, `Move`, `Select`, `Set`, `Rename`, `Delete`, `Go`, `FileType`) is a verb-oriented DSL with keyword parameters. Shell lines are prefixed with `@` and run as child processes with the current selection injected via token substitution. The `@script` directive drops into full JScript/VBScript for anything the DSL can't express.

**Key implementation traps for zen-man.** The command registry is the core primitive: define a `map[string]CommandHandler` in Go where each handler is a pure function `(ctx CommandContext) -> (Result, error)`. This makes testing easy and makes the "dry run" preview mode trivial (pass a `dryRun: true` flag in the context and have handlers return what they *would* do without doing it). Token substitution must happen before dispatch, not inside individual handlers, so the substitution logic is centralized and auditable. Shell passthrough needs an explicit allow-list configurable by the user — don't allow arbitrary shell execution by default. The command editor UI benefits enormously from a small autocomplete system: type `Se` and get `Select`, `Set` as suggestions, with parameter hints inline.

---

**Summary of cross-cutting architectural concerns for zen-man:**

The five features share a core architectural need: a clean separation between the *virtual presentation state* (what the frontend renders) and the *real file system state* (what the backend sees). Flat View, Folder Formats, and the Filter Bar all operate on the presentation layer with zero backend involvement for their core behavior. The Rename Tool and Command Editor touch the real file system but should preview in the browser first. This layering — frontend-virtual first, backend-real only on commit — is the key to making all five feel fast and safe.