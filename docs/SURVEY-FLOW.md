# Survey Flow: structure, drag-and-drop, embedded data and redirects

The Survey Flow is a tree. This is the reference for how that tree is
addressed, what may go where, how a drag becomes a saved change, and how the
two data-carrying elements — embedded data and redirect — are configured.

Everything here is additive: a survey saved before any of it existed parses,
opens, runs and exports exactly as it did.

---

## 1. One tree, one set of rules

| Concern | Lives in |
| --- | --- |
| addressing, nesting rules, moves | `packages/engine/src/flowTree.ts` |
| typed embedded data + expressions | `packages/engine/src/embedded.ts` |
| redirect URLs and their variables | `packages/engine/src/redirect.ts` |
| the drag surface | `apps/studio/components/studio/FlowDnd.tsx` |
| the recursive tree UI | `apps/studio/components/studio/FlowPanel.tsx` |

The Studio's drag zones, its ⋮ menus, its keyboard moves and its structure
check all call the *same* engine functions. A drag cannot do something a menu
would refuse, and neither can produce a flow the runtime will not walk.

### Addressing

A node can hold more than one list — a branch has one per condition plus its
`otherwise` — so a position needs three parts:

```
container = { ownerId, slot }      slot: "children" | "otherwise" | "branch:<id>"
index     = where in that list
```

`ownerId: null` is the root. `locateNode(flow, id)` returns the container and
index of any node at any depth; `allContainers(flow)` enumerates every list in
the survey, which is what fills the ⋮ menu's "Move into…".

### What contains what

`containerSlots(node)` declares the lists a node owns:

| node | lists |
| --- | --- |
| `section` (Group), `randomizer`, `loop` | `children` |
| `branch` | one per condition, plus `otherwise` |
| `block` | **none** — its pages are the Questions tab's business |
| everything else | none |

A **new container type joins the drag system by appearing in that function**.
No drag code changes.

Refusals (`canDropFlowNode`) are the whole list, and there are only four:

* a node inside itself, or inside anything it already contains;
* a slot the owner does not have;
* an `end` inside a `randomizer` or a `loop` — everything after it becomes
  unreachable in the orders that put it first;
* a container or reference that no longer exists.

Anything else is allowed, which is why groups nest in randomizers, randomizers
nest in randomizers, and either nests in a branch path.

### Moves preserve structure by construction

`moveFlowNode` clones the flow, splices the node object out of one list and
into another **by reference**. Ids, questions, conditions, randomization
settings, quotas, piping and page breaks are the same objects afterwards
because nothing is rebuilt. `flowTree.test.ts` moves a branch across three
containers and asserts its JSON is byte-identical.

`removeFlowNode`, `insertFlowNode` and `cloneFlowSubtree` complete the set.
Duplication regenerates every id in the subtree — two nodes claiming one id
resolve to the first, so the copy would silently never run.

**"Append" means the end of the reachable part.** A move into a list with no
index lands *before* the first `end` node, because the flow stops there.

### Validation

`validateFlowStructure(flow)` reports duplicate ids, elements nested where they
are not allowed, non-page children of a block, and anything after the End node.
It shows on the Survey Flow panel and in **Logic → Logic check**, next to
`lintSurveyLogic`'s reference errors.

---

## 2. The drag surface

Pointer events, not native HTML5 drag: native drag cannot style a "not
allowed" state meaningfully, cannot show a preview of Claude's choosing, and
cannot be driven from a test.

* **Handle only.** `⠿` starts a drag; the rest of the card stays clickable,
  so text fields and toggles inside it still work.
* **A press is not a drag** until the pointer moves 4px.
* **Zones appear on drag, not at rest** — and take their full height the
  moment the drag starts, so hovering never reflows the page under the cursor.
* **Every zone is painted with its own answer**: valid (blue line), invalid
  (red), hovered (labelled DROP HERE / DROP INSIDE / the refusal reason).
* **The preview follows the cursor** with what is being carried
  ("Concept exposure · 4 blocks") and what will happen ("Release to move
  here", or the reason it cannot).
* **Esc cancels**; the pointer leaving the panel does not.

Hit-testing is `document.elementFromPoint` → `closest("[data-drop-key]")`, so
nested zones resolve to the innermost one without any z-index arithmetic.

Verdicts are computed once per zone per drag and cached, so a 200-node flow
does not re-evaluate the rules on every mouse move.

### Without a drag

The ⋮ menu on every card offers Move up / Move down / Duplicate / Delete and
**Move into…**, listing every container that would accept this element, by
name (`Group “Demographics”`, `Branch — “Qualified”`). The list is filtered
through `canDropFlowNode`, so it can never offer a move the drag refuses.

### Undo

`⌘Z` / `⌘⇧Z`, or the buttons in the Survey Flow header. The store keeps the
last 50 definitions; a structural drag is one entry, labelled with what it did
("move Concept exposure"). Keystrokes inside a text field are left to the
browser, which has its own undo there.

---

## 3. Typed embedded data

```jsonc
{
  "name": "customer_score",
  "dataType": "integer",        // string | integer | decimal | boolean | date | datetime
  "source": "url",              // url | panel | static | expression
  "value": "Q1 + Q2",           // for static / expression
  "defaultValue": "25"          // when the source produced nothing
}
```

Everything from a URL or a panel is text. Without a type, `score > 80`
compares `"9"` with `"80"` as strings and says yes. The type is applied once,
at capture, so every later comparison, calculation and piped token sees a real
number, boolean or date.

* **No declared type means no conversion** — not "convert to string". A field
  that already held a number still holds that number.
* **An untyped field that captured nothing writes no key at all**, so existing
  exports do not gain a column of nulls.
* A value that cannot be read as its type is reported in the editor
  (`"abc" is not a number`) rather than silently becoming null at runtime.

### Expressions

The stored value is expression text — the same string the engine evaluates and
the exports show. `IF x THEN y ELSE z` is rewritten to the calc DSL's
`if(x, y, z)` before parsing (nesting included, string literals skipped), and
the editor shows the rewrite so what will run is never a surprise.

`checkEmbeddedExpression` validates syntax and every reference against the
survey's actual questions, calculations and embedded fields. The builder
palette inserts references, operators and functions by clicking.

### In logic

`embeddedCatalog(def)` lists every embedded field declared **anywhere in the
flow**, with its type, and fills the condition builder's source dropdown — so
typed embedded data drives display, skip, branch, option, validation and
randomization logic like any other source.

---

## 4. Redirects

```jsonc
{ "type": "redirect", "url": "https://panel.com/done?id={{ed.PANEL_ID}}", "newWindow": true }
```

* Tokens are the platform's ordinary piping tokens, resolved when the
  respondent reaches the step.
* A URL is **not** HTML: values are percent-encoded, not HTML-escaped.
  `Ben & Jerry` arrives whole instead of truncating the query string.
* `validateRedirectUrl` checks scheme, host and shape *with tokens masked*, so
  a template is never rejected for using the feature it is using. `http://`
  is allowed with a warning.
* The variable picker lists embedded data, question answers (code and label),
  calculations and system values, and writes the token for you.
* End-of-survey redirect URLs get the same treatment.

`newWindow` opens the panel's page in a new tab and leaves the completion page
in place; some panels require the survey tab to stay open.
