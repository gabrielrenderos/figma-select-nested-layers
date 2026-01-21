# How It Works: In 3 Steps
1. Start with a symbol to define the type of layer (optional).
2. Use slashes (/ or //) to define nesting between names.
3. Add modifiers at the end to change search behavior.

---

# 1. Search Types
Prefix symbols to filter by layer type. Add one of these symbols before the name of the layer you're searching to define its type:

- # Page
- `$` Section
- `@` Frame
- `!` Instance
- `?` Component
- `&` Image
- `%` Shape
- `=` Text

**Notes:**
- Case insensitive.
- Partial names work.
- You can combine multiple types in one query, but nesting must be valid.
- Valid: `#Page/@Frame/!Instance`
- Invalid: `@Frame/=Text/#Page`
- If no symbol is used, it searches all layer types inside your current selection. If nothing is selected, it searches inside the current page.

---

# 2. Search Scope
Slashes define structure between names:

- `/` searches through all descendants.
- `//` searches only direct children (one level deep).

**Examples:**

- `Button`
Finds layers with "Button" in their name inside the current selection or page.

- `@Main Frame / Button`
Finds frames named "Main Frame", then searches inside them for any layer matching "Button".

- `@Card // CTA`
Finds only direct children named "CTA" inside each frame called "Card".

**Scope behavior:**
- Scope is defined by your current selection.
- If nothing is selected, the current page is used as scope.
- Every query starts fresh from that scope.
- Leading `//` at the very start applies only to the first part relative to your selection. Later parts are not forced to be direct children unless you add `//` again next to that part.
- Slashes inside quoted text are treated as part of the name, not as scope separators (useful for names like `"Item /"`).

---

# 3. Modifiers
Add these at the end of your query:
- `--f` Stop at the first match overall.
- `--fe` Stop at the first match in each specified scope.
- `--h` Search hidden layers only.
- `--a` Search all layers, including hidden and visible.
- `--#` Pick the N‑th match overall in visual order (e.g. `--3`).
- `--#e` Pick the N‑th match in each scope in visual order (e.g. `--2e`).

Inline index placement
- You can place `--#` and `--#e` right next to the path part they apply to. Example: `@Dropdown List --1e/@Dropdown Option` picks the first list in each scope, then returns all options inside those lists.
- `--0` and `--0e` mean “last” (global or per‑scope) for that part.

You can combine modifiers, always using the double dash `--` before each one.

**Examples:**

- `@Modal --h`
Searches for hidden frames named "Modal".

- `@Card/Button --f`
Finds the first matching "Button" inside "Card" frames.

- `#Page/@Main Frame/!Logo --fe`
Finds the first matching Page and switches to it, then finds all layers named "Main Frame", and inside of each of those layers, finds and selects the first matching instance "Logo".

- `!Field --1`
Selects the first matching instance of "Field" by rows (top→bottom, left→right) inside your current scope.

- `@Container/@Form Section --3e`
Looks for frames named "Container", then inside each container picks the 3rd "Form Section" by visible order.

- `@Dropdown List --0/@Dropdown Option`
Picks the last dropdown list, then selects all options inside it.

- `#Page/Cats and Dogs//& --a`
Finds the first matching Page and switches to it, searches for all frames called "Cats and Dogs" (hidden and visible, of any type), then selects all images that are a direct children of the "Carts and Dogs" layers.

---

# Name Matching Considerations:
- Unquoted text is fuzzy by default (case-insensitive partial match).
- Quoted text is literal and case-sensitive; spaces and symbols inside quotes are matched exactly.
- A fully quoted term is an exact full-name match (e.g. `"=Icon"` matches only a layer literally named `=Icon` of any type; `="Icon"` matches a text layer named exactly `Icon`).
- Multiple tokens are ANDed together. Quoted tokens keep slashes `/` as part of the name instead of splitting scope (e.g. `!Menu "Item /" =Icon` requires an instance name containing `Menu`, the literal `Item /`, and `=Icon`).
- Using `--h` (hidden only) or `--a` (all layers) will slow down the plugin search performance in big files. This happens because Figma materializes invisible children of instances when either modifier is used. That materialization is a document-level state that persists for the session and cannot be programmatically “unloaded” by plugins. The only way to fully clear it is to reload the file, or closing it and opening it back up.

---

# Index Modifiers

Index selection lets you choose “which one” to select when there are multiple matches.

- `--#` Global index
  - Format: `--N` (for example, `--1`, `--2`, `--3`)
  - Meaning: pick the N‑th match overall in your result list.
  - Visual order: rows top→bottom, then left→right. Overlap does not change the index order regardless of which one is at the forefront.
  - Example: `=Search --1` picks the first text layer named “Search” inside your scope.

- `--#e` Per‑scope index (each scope gets its own N)
  - Format: `--Ne` (for example, `--1e`, `--2e`, `--3e`)
  - Meaning: for each scope in your query, pick the N‑th match within that scope.
  - Best for nested queries like `@Card/Button --1e` (first “Button” inside each “Card”).

Inline placement
- Place the index right next to the part it applies to: `@Table/@Row --1e/Cell`.
- Global inline `--#` narrows to that one match and continues the query inside it.

0 means “last”
- `--0` picks the last match overall; `--0e` picks the last in each scope.

**Tips**
- Scopes come from your selection and from the nest you specify (e.g., `@Card/...`).
- The index order is always based on visible reading order (rows top→bottom, then 
left→right).