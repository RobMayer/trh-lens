# @trh/lens

Type-safe optics for reading, mutating, and immutably updating deeply nested data structures in TypeScript.

```
npm install @trh/lens
```

## Core API

The library exports a single `Lens` namespace with three operations. All three take a data object and a lens callback that describes the path to a target value.

```ts
import { Lens } from "@trh/lens";
```

### Lens.get -- read a value

```ts
const data = { users: [{ name: "Alice" }, { name: "Bob" }] };

Lens.get(data, $ => $("users")(0)("name"));   // "Alice"
Lens.get(data, $ => $("users")(1)("name"));   // "Bob"
```

### Lens.mutate -- modify in place

Mutates the original object. Returns `void`.

```ts
Lens.mutate(data, $ => $("users")(0)("name"), "Alicia");
// data.users[0].name is now "Alicia"
```

### Lens.apply -- immutable update

Returns a new object with structural sharing. The original is untouched.

```ts
const updated = Lens.apply(data, $ => $("users")(0)("name"), "Alicia");
// updated.users[0].name === "Alicia"
// data.users[0].name === "Alice" (unchanged)
// updated.users[1] === data.users[1] (shared)
```

### Updater functions

Both `mutate` and `apply` accept either a static value or an updater function:

```ts
Lens.mutate(data, $ => $("users")(0)("name"), (prev, index, ctx) => prev.toUpperCase());
```

The updater receives:
- `prev` -- the current value at the target location
- `index` -- the iteration index (0 for non-iterated paths, element index inside `each()`)
- `ctx` -- a `Lens.Context` with `{ path, index, count }` for full traversal metadata

In `apply`, `prev` is typed as `DeepReadonly` to discourage accidental mutation.

## Navigation

### Property access

Navigate into object properties by calling the lens proxy with a string key:

```ts
Lens.get(data, $ => $("address")("city"));
```

### Array index access

Navigate into arrays by calling with a numeric index, or using `.at()`:

```ts
Lens.get(data, $ => $("items")(0));
Lens.get(data, $ => $("items").at(-1));   // last element
```

Both support negative indices (counted from the end).

### each() -- iterate arrays

`each()` fans out over every element. With `get`, the result is collected into an array. With `mutate`/`apply`, every element is updated.

```ts
const data = { users: [{ name: "Alice" }, { name: "Bob" }] };

Lens.get(data, $ => $("users").each()("name"));
// ["Alice", "Bob"]

Lens.mutate(data, $ => $("users").each()("name"), name => name.toUpperCase());
// all names uppercased in-place
```

`each()` also accepts a callback for more complex sub-navigation:

```ts
const data = { groups: [{ items: [{ x: 1 }, { x: 2 }] }, { items: [{ x: 3 }] }] };

Lens.get(data, $ => $("groups").each($g => $g("items").each()("x")));
// [1, 2, 3]
```

## Filtering

Filters are chainable and narrow which array elements are affected. They apply to subsequent `each()` or `at()` calls.

### where() -- predicate-based filtering

```ts
const data = { users: [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }] };

Lens.get(data, $ => $("users").where($ => [$("age"), ">=", 30]).each()("name"));
// ["Alice"]
```

See [Predicate Reference](#predicate-reference) for the full operator list.

### filter() -- function-based filtering

```ts
Lens.get(data, $ => $("users").filter(u => u.age >= 30).each()("name"));
// ["Alice"]
```

### slice()

```ts
Lens.get(data, $ => $("items").slice(0, 2).each());
```

### sort()

Sort by a lens path with a direction:

```ts
Lens.get(data, $ =>
    $("users").sort($ => $("age"), "desc").each()("name")
);
```

Direction can be `"asc"`, `"desc"`, or `{ direction: "asc" | "desc", nullish?: "first" | "last" }`.

Sort also accepts a raw comparator:

```ts
Lens.get(data, $ =>
    $("users").sort((a, b) => a.age - b.age).each()("name")
);
```

### Chaining filters

Filters compose -- you can chain `where`, `filter`, `sort`, and `slice` in any order before `each()` or `at()`:

```ts
Lens.get(data, $ =>
    $("users")
        .where($ => [$("active"), "?"])
        .sort($ => $("name"), "asc")
        .slice(0, 10)
        .each()("name")
);
```

## Read-only Accessors

These return derived values and cannot be used as mutation targets.

### size()

Works on strings (character count), arrays, Maps, Sets, and plain objects (key count):

```ts
Lens.get(data, $ => $("users").size());     // 2
Lens.get(data, $ => $("name").size());      // 5
```

### length()

Array/string `.length`:

```ts
Lens.get(data, $ => $("items").length());
```

### keys(), values(), entries()

Work on plain objects and Maps:

```ts
Lens.get(data, $ => $("config").keys());      // ["a", "b", ...]
Lens.get(data, $ => $("config").values());
Lens.get(data, $ => $("config").entries());    // [["a", 1], ["b", 2], ...]
```

### transform()

Apply an arbitrary function. Read-only -- cannot be a mutation target:

```ts
Lens.get(data, $ => $("name").transform(s => s.split(" ")));
// ["Alice", "Smith"]
```

## Map and Set Support

### Map

```ts
const data = { lookup: new Map([["x", { value: 1 }]]) };

// Read
Lens.get(data, $ => $("lookup").get("x")("value"));   // 1

// Mutate
Lens.mutate(data, $ => $("lookup").get("x")("value"), 42);

// Read-only accessors
Lens.get(data, $ => $("lookup").has("x"));     // true
Lens.get(data, $ => $("lookup").keys());       // ["x"]
Lens.get(data, $ => $("lookup").size());       // 1
```

`get()` is the only Map accessor that supports mutation/apply -- it navigates into the value.

### Set

```ts
Lens.get(data, $ => $("tags").has("admin"));   // true/false
Lens.get(data, $ => $("tags").size());         // number
```

## Predicate Reference

Predicates are used inside `where()`. They are tuples of `[subject, operator, operand?]`.

The subject is a lens path: `$("fieldName")`. The operand can be a literal value or another lens path.

### Unary operators

| Operator | Meaning |
|----------|---------|
| `?`      | truthy  |
| `!?`     | falsy   |

```ts
.where($ => [$("active"), "?"])
```

### Equality

| Operator | Meaning |
|----------|---------|
| `=`      | equals (protocol-aware, then loose `==`) |
| `!=`     | not equals |
| `==`     | strict equals (`===`) |
| `!==`    | not strict equals |

### Ordering

| Operator | Meaning |
|----------|---------|
| `>`      | greater than |
| `<`      | less than |
| `>=`     | greater or equal |
| `<=`     | less or equal |

Negated forms (`!>`, `!<`, `!>=`, `!<=`) are also available. Ordering uses `@trh/symbols` `Compare` protocol, then falls back to native numeric/string comparison.

### Range

| Operator | Meaning |
|----------|---------|
| `><`     | between, exclusive |
| `>=<`    | between, inclusive |

Range predicates take four elements:

```ts
.where($ => [$("age"), ">=<", 18, 65])
```

### String operators

| Operator | Meaning |
|----------|---------|
| `%`      | contains |
| `%^`     | contains (case-insensitive) |
| `%_`     | starts with |
| `%^_`    | starts with (case-insensitive) |
| `_%`     | ends with |
| `_%^`    | ends with (case-insensitive) |
| `~`      | regex match |

### Collection operators

| Operator | Meaning |
|----------|---------|
| `#`      | contains element (arrays, Sets, or `@trh/symbols` `Containable`) |
| `:`      | type check (via `startsWith` on resolved type string) |

### Any-of / All-of variants

Append `\|` to test if **any** operand matches, or `&` if **all** must match. The operand becomes an array:

```ts
.where($ => [$("status"), "=|", ["active", "pending"]])    // equals any of
.where($ => [$("tags"), "#&", ["admin", "verified"]])       // contains all of
.where($ => [$("name"), "%|", ["Ali", "Bob"]])              // contains any of
.where($ => [$("type"), ":|", ["string", "number"]])        // type is any of
```

### Logical combinators

Available on the `$` parameter inside `where()`:

```ts
.where($ => $.or(
    [$("age"), ">", 30],
    [$("role"), "=", "admin"]
))

.where($ => $.and(
    [$("active"), "?"],
    $.not([$("banned"), "?"])
))

.where($ => $.xor(
    [$("a"), "?"],
    [$("b"), "?"]
))
```

## Custom Accessors (LensNav)

Objects can define custom lens-navigable accessors using `@trh/symbols`'s `LensNav` symbol. This lets domain types participate in lens navigation with full `get`/`mutate`/`apply` support.

```ts
import { TrhSymbols } from "@trh/symbols";

class Grid {
    cells: number[][];

    get [TrhSymbols.LensNav]() {
        return {
            cell: {
                select: (row: number, col: number) => this.cells[row][col],
                mutate: (value: number, row: number, col: number) => {
                    this.cells[row][col] = value;
                },
                apply: (value: number, row: number, col: number) => {
                    const copy = new Grid();
                    copy.cells = this.cells.map(r => [...r]);
                    copy.cells[row][col] = value;
                    return copy;
                },
            },
        };
    }
}

Lens.get(grid, $ => $("grid").cell(0, 1));
Lens.mutate(grid, $ => $("grid").cell(0, 1), 42);
```

Each accessor object needs:
- `select(...args) => value` -- required, used for reading
- `mutate(newValue, ...args)` -- optional, used by `Lens.mutate`
- `apply(newValue, ...args) => newOwner` -- optional, used by `Lens.apply`

## Type System

The lens callback parameter (`$`) is typed differently depending on the operation:

- `Lens.get` provides a `Selector` -- all navigation is available, the return type tracks what `get` will produce
- `Lens.mutate` provides a `Mutator` -- only paths that can be written to are valid terminal targets
- `Lens.apply` provides an `Applier` -- same as `Mutator`

Read-only accessors (`transform`, `size`, `keys`, `where`, `filter`, etc.) return lenses with `Target = never`, which makes them structurally incompatible with `MutatorFor` / `ApplierFor`. This means the type system prevents you from using a read-only path as a mutation target:

```ts
// Type error: transform() returns a read-only lens
Lens.mutate(data, $ => $("name").transform(s => s.toUpperCase()), "x");
```

## License

UNLICENSE
