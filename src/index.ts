import { TrhSymbols } from "@trh/symbols";

//#region - Public API

export namespace Lens {
    export const get = <D, R>(data: D, lens: ($: SelectorLens<D>) => SelectorLensOf<R>): R => {
        const proxy = createProxy({ value: data, isEach: false, path: [], filters: [] });
        const result = lens(proxy);
        return (result as any)[LENS].value;
    };

    export type Context = { path: LensPathSegment[]; index: number; count: number };

    export const mutate = <D, R>(data: D, lens: ($: MutatorLens<D>) => MutatorLensOf<R>, value: R | ((prev: R, index: number, context: Lens.Context) => R)): void => {
        const proxy = createProxy({ value: data, isEach: false, path: [], filters: [] });
        const result = lens(proxy as any);
        const { path } = (result as any)[LENS] as LensState;
        if (path.length === 0) return; // can't replace root by reference
        const updater = typeof value === "function" ? (value as (prev: R, index: number, context: Lens.Context) => R) : () => value;
        doMutate(data, path, 0, updater as any, { path: [], index: 0, count: 1 });
    };

    export const apply = <D, R>(data: D, lens: ($: ApplierLens<D>) => ApplierLensOf<R>, value: R | ((prev: DeepReadonly<R>, index: number, context: Lens.Context) => R)): D => {
        const proxy = createProxy({ value: data, isEach: false, path: [], filters: [] });
        const result = lens(proxy as any);
        const { path } = (result as any)[LENS] as LensState;
        const updater = typeof value === "function" ? (value as (prev: R, index: number, context: Lens.Context) => R) : () => value;
        if (path.length === 0) return updater(data as any, 0, { path: [], index: 0, count: 1 }) as any;
        return doApply(data, path, 0, updater as any, { path: [], index: 0, count: 1 });
    };
}

//#endregion

//#region - Symbols

// Distributes keyof over union members: AllStringKeys<A | B> = keyof A | keyof B
type AllStringKeys<T> = T extends any ? keyof T & string : never;

// Safe lookup across union members: yields the value type where the key exists, undefined elsewhere
type SafeLookup<T, K extends string> = T extends any ? (K extends keyof T ? T[K] : undefined) : never;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type DeepReadonly<T> = T extends Primitive
    ? T
    : T extends Function
      ? T
      : T extends ReadonlyArray<infer U>
        ? ReadonlyArray<DeepReadonly<U>>
        : T extends ReadonlyMap<infer K, infer V>
          ? ReadonlyMap<K, DeepReadonly<V>>
          : T extends ReadonlySet<infer U>
            ? ReadonlySet<DeepReadonly<U>>
            : { readonly [K in keyof T]: DeepReadonly<T[K]> };

type LensPathSegment = { type: "property"; key: string } | { type: "index"; index: number } | { type: "accessor"; name: string; args?: string[] };

const LENS = Symbol("lens");
const PRED = Symbol("pred");

type FilterOp = { type: "where"; predFn: Function } | { type: "filter"; fn: Function } | { type: "slice"; start: number; end?: number } | { type: "sort"; args: any[] };

type PathStep =
    | { type: "prop"; key: string | number }
    | { type: "at"; index: number; filters?: FilterOp[] }
    | { type: "each"; filters?: FilterOp[]; callback?: Function }
    | { type: "mapGet"; key: unknown }
    | { type: "custom"; prop: string; args: unknown[] };

type LensState = { value: unknown; isEach: boolean; path: PathStep[]; filters: FilterOp[] };

//#endregion

//#region - Shared helpers

/** If arg is a LENS proxy, extract its value. Otherwise return as-is. */
const unwrap = (arg: unknown): unknown => {
    const lens = typeof arg === "function" ? (arg as any)[LENS] : undefined;
    return lens ? lens.value : arg;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: unknown, b: unknown): number | null {
    // 1. Left-side Compare symbol
    if (a != null && typeof a === "object" && TrhSymbols.Compare in a) {
        const result = (a as any)[TrhSymbols.Compare](b);
        if (result !== null && !isNaN(result)) return result;
    }
    // 2. Right-side Compare symbol (flipped sign)
    if (b != null && typeof b === "object" && TrhSymbols.Compare in b) {
        const result = (b as any)[TrhSymbols.Compare](a);
        if (result !== null && !isNaN(result)) return -result;
    }
    // 3. Numeric comparison
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "bigint" && typeof b === "bigint") return Number(a - b);
    // 4. String comparison with natural collation
    if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
    // 5. Incomparable types
    return null;
}

function performEquality(a: unknown, b: unknown): boolean {
    // 1. Left-side Equals symbol
    if (a != null && typeof a === "object" && TrhSymbols.Equals in a) {
        const result = (a as any)[TrhSymbols.Equals](b);
        if (result !== null) return result;
    }
    // 2. Right-side Equals symbol
    if (b != null && typeof b === "object" && TrhSymbols.Equals in b) {
        const result = (b as any)[TrhSymbols.Equals](a);
        if (result !== null) return result;
    }
    // 3. Strict equality fallback
    return a === b;
}

function resolveTypeOf(value: unknown): string {
    if (value === null) return "nullish/null";
    if (value === undefined) return "nullish/undefined";
    switch (typeof value) {
        case "number":
            return "number/native";
        case "bigint":
            return "number/bigint";
        case "boolean":
            return "boolean";
        case "string":
            return "string";
        case "symbol":
            return "symbol";
        case "function":
            return "function";
    }
    // Check custom TypeOf symbol first
    if (typeof (value as any)[TrhSymbols.TypeOf] === "function") {
        const custom = (value as any)[TrhSymbols.TypeOf]();
        if (typeof custom === "string") return custom;
    }
    if (Array.isArray(value)) return "array";
    if (value instanceof Date) return "date";
    if (value instanceof Set) return "set";
    if (value instanceof Map) return "map";
    if (value instanceof RegExp) return "regexp";
    if (value instanceof Promise) return "promise";
    if (value instanceof Error) return "error";
    const tag = (value as any)[Symbol.toStringTag];
    if (typeof tag === "string") return tag.toLowerCase();
    return "object";
}

function convertToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
        case "string":
            return value;
        case "number":
        case "bigint":
            return value.toString();
        case "boolean":
            return null;
    }
    if (Array.isArray(value)) return null;
    if (typeof (value as any).toString === "function" && (value as any).toString !== Object.prototype.toString) {
        return (value as any).toString();
    }
    return null;
}

function sortCompare(a: unknown, b: unknown): number {
    // 1. Compare symbol / native types
    const cmp = compare(a, b);
    if (cmp !== null) return cmp;

    // 2. Numeric coercion
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;

    // 3. String fallback
    return collator.compare(String(a), String(b));
}

//#endregion

//#region - Operator table

const cmpOp = (test: (c: number) => boolean) => (s: any, o: any) => {
    const c = compare(s, o);
    return c !== null && test(c);
};

const stringOp = (check: (a: string, b: string) => boolean) => (s: any, o: any) => {
    const a = convertToString(s),
        b = convertToString(o);
    return a !== null && b !== null && check(a, b);
};

const rangeOp = (loTest: (c: number) => boolean, hiTest: (c: number) => boolean) => (s: any, lo: any, hi: any) => {
    const ord = compare(lo, hi);
    if (ord === null) return false;
    const [l, h] = ord <= 0 ? [lo, hi] : [hi, lo];
    const cL = compare(s, l);
    const cH = compare(s, h);
    return cL !== null && cH !== null && loTest(cL) && hiTest(cH);
};

const OPS: Record<string, (subject: any, operand: any, operand2?: any) => boolean> = {
    "=": (s, o) => performEquality(s, o),
    "==": (s, o) => s == o,
    ">": cmpOp((c) => c > 0),
    "<": cmpOp((c) => c < 0),
    ">=": cmpOp((c) => c >= 0),
    "<=": cmpOp((c) => c <= 0),
    "%": stringOp((a, b) => a.includes(b)),
    "%^": stringOp((a, b) => a.toLowerCase().includes(b.toLowerCase())),
    "%_": stringOp((a, b) => a.startsWith(b)),
    "%^_": stringOp((a, b) => a.toLowerCase().startsWith(b.toLowerCase())),
    "_%": stringOp((a, b) => a.endsWith(b)),
    "_%^": stringOp((a, b) => a.toLowerCase().endsWith(b.toLowerCase())),
    "~": (s, o) => {
        const str = convertToString(s);
        if (str === null) return false;
        try {
            return (o instanceof RegExp ? o : new RegExp(o)).test(str);
        } catch {
            return false;
        }
    },
    "#": (s, o) => (s != null && typeof s === "object" && TrhSymbols.Contains in s ? (s as any)[TrhSymbols.Contains](o) : Array.isArray(s) ? s.includes(o) : s instanceof Set ? s.has(o) : false),
    ":": (s, o) => resolveTypeOf(s).startsWith(String(o)),
    "><": rangeOp((c) => c > 0, (c) => c < 0),
    ">=<": rangeOp((c) => c >= 0, (c) => c <= 0),
};

//#endregion

//#region - Predicate evaluation

function evalPredicate(pred: any): boolean {
    // PredicateResult pass-through
    if (pred != null && typeof pred === "object" && PRED in pred) return (pred as any)[PRED];

    const tuple = pred as unknown[];

    // Arity 2 — unary
    if (tuple.length === 2) {
        const val = unwrap(tuple[0]);
        return tuple[1] === "?" ? !!val : !val;
    }

    const subject = unwrap(tuple[0]);
    const rawOp = tuple[1] as string;

    // Parse operator: !prefix, |/& suffix
    let negate = false;
    let mode: "single" | "any" | "all" = "single";
    let base = rawOp;

    if (base.startsWith("!")) {
        negate = true;
        base = base.slice(1);
    }
    if (base.endsWith("|")) {
        mode = "any";
        base = base.slice(0, -1);
    } else if (base.endsWith("&")) {
        mode = "all";
        base = base.slice(0, -1);
    }

    const op = OPS[base];
    if (!op) return false;

    let result: boolean;

    if (tuple.length === 4) {
        // Range op — two operands
        result = op(subject, unwrap(tuple[2]), unwrap(tuple[3]));
    } else if (mode === "single") {
        result = op(subject, unwrap(tuple[2]));
    } else {
        // any-of or all-of — operand is an array
        const operands = tuple[2] as unknown[];
        const method = mode === "any" ? "some" : "every";
        result = operands[method]((o: unknown) => op(subject, unwrap(o)));
    }

    return negate ? !result : result;
}

//#endregion

//#region - Proxy factory

function createProxy(state: LensState): any {
    const { value, isEach, path, filters } = state;

    // Transform value without recording a path step (read-only ops: size, length, keys, values, has, transform)
    const apply = (fn: (v: any) => unknown): any => createProxy({ value: isEach ? (value as any[]).map(fn) : fn(value), isEach, path, filters: [] });

    // Transform value AND record a path step (navigational ops used by mutate/apply)
    const nav = (fn: (v: any) => unknown, s: PathStep): any => createProxy({ value: isEach ? (value as any[]).map(fn) : fn(value), isEach, path: [...path, s], filters: [] });

    // Fold current filters into a path step (only when there are pending filters)
    const foldFilters = (): FilterOp[] | undefined => (filters.length ? [...filters] : undefined);

    const handler: ProxyHandler<Function> = {
        // $("key") / $(index) — property/index access (supports negative indices on arrays)
        apply(_target, _thisArg, args) {
            const key = unwrap(args[0]);
            if (typeof key === "number" && key < 0) {
                return createProxy({
                    value: isEach ? (value as any[]).map((v: any) => v?.[v.length + key]) : (value as any)?.[(value as any[]).length + key],
                    isEach,
                    path: [...path, { type: "at" as const, index: key, filters: foldFilters() }],
                    filters: [],
                });
            }
            return nav((v: any) => (v == null ? undefined : v[key as string | number]), { type: "prop", key: key as string | number });
        },

        get(_target, prop) {
            // Internal state extraction
            if (prop === LENS) return state;

            switch (prop) {
                //#region - Universal
                case "transform":
                    return (fn: (v: any) => any) => apply(fn);
                //#endregion

                //#region - Size / Length
                case "size":
                    return () =>
                        apply((v: any) => {
                            if (v == null) return 0;
                            if (typeof v === "string" || Array.isArray(v)) return v.length;
                            if (v instanceof Map || v instanceof Set) return v.size;
                            if (typeof v === "object") return Object.keys(v).length;
                            return 0;
                        });
                case "length":
                    return () => apply((v: any) => v?.length ?? 0);
                //#endregion

                //#region - Array accessors
                case "at":
                    return (rawIndex: number) => {
                        const index = unwrap(rawIndex) as number;
                        return createProxy({
                            value: isEach ? (value as any[]).map((v: any) => v?.[index < 0 ? v.length + index : index]) : (value as any)?.[index < 0 ? (value as any[]).length + index : index],
                            isEach,
                            path: [...path, { type: "at" as const, index, filters: foldFilters() }],
                            filters: [],
                        });
                    };
                case "each":
                    return (callback?: Function) => {
                        const filters = foldFilters();
                        if (callback) {
                            const arr = isEach ? (value as any[]).flat(1) : (value as any[]);
                            const mapped = (arr ?? [])
                                .map((item: any) => {
                                    const result = callback(wrapValue(item));
                                    const inner = (result as any)[LENS];
                                    return inner.isEach ? inner.value : [inner.value];
                                })
                                .flat(1);
                            return createProxy({
                                value: mapped,
                                isEach: true,
                                path: [...path, { type: "each" as const, filters, callback }],
                                filters: [],
                            });
                        }
                        const nextPath = [...path, { type: "each" as const, filters }];
                        if (isEach) return createProxy({ value: (value as any[]).flat(1), isEach: true, path: nextPath, filters: [] });
                        return createProxy({ value, isEach: true, path: nextPath, filters: [] });
                    };
                //#endregion

                //#region - Object / Map accessors
                case "keys":
                    return () =>
                        apply((v: any) => {
                            if (v instanceof Map) return [...v.keys()];
                            if (v != null && typeof v === "object") return Object.keys(v);
                            return [];
                        });
                case "values":
                    return () =>
                        apply((v: any) => {
                            if (v instanceof Map) return [...v.values()];
                            if (v != null && typeof v === "object") return Object.values(v);
                            return [];
                        });
                case "entries":
                    return () =>
                        apply((v: any) => {
                            if (v instanceof Map) return [...v.entries()];
                            if (v != null && typeof v === "object") return Object.entries(v);
                            return [];
                        });
                //#endregion

                //#region - Map / Set
                case "get":
                    return (rawKey: any) => {
                        const key = unwrap(rawKey);
                        return nav((v: any) => v?.get?.(key), { type: "mapGet", key });
                    };
                case "has":
                    return (rawVal: any) => {
                        const val = unwrap(rawVal);
                        return apply((v: any) => v?.has?.(val) ?? false);
                    };
                //#endregion

                //#region - Filtering (accumulate in state.filters, don't record path steps)
                case "where":
                    return (predFn: Function) => {
                        const filterArr = (arr: any[]) => arr.filter((item) => evalPredicate(predFn(wrapValue(item))));
                        const nextFilters = [...filters, { type: "where" as const, predFn }];
                        if (isEach) return createProxy({ value: (value as any[]).map((v) => filterArr(v)), isEach: true, path, filters: nextFilters });
                        return createProxy({ value: filterArr(value as any[]), isEach: false, path, filters: nextFilters });
                    };
                case "filter":
                    return (fn: Function) => {
                        const nextFilters = [...filters, { type: "filter" as const, fn }];
                        if (isEach) return createProxy({ value: (value as any[]).map((v: any[]) => v.filter(fn as any)), isEach: true, path, filters: nextFilters });
                        return createProxy({ value: (value as any[]).filter(fn as any), isEach: false, path, filters: nextFilters });
                    };
                //#endregion

                //#region - Sort / Slice
                case "sort":
                    return (...args: any[]) => {
                        const sortArr = (arr: any[]) => {
                            if (typeof args[0] === "function" && args.length === 1) {
                                return [...arr].sort(args[0]);
                            }
                            const { dir, nullish } = parseSortArgs(args);
                            const keyed = arr.map((item, i) => ({ item, key: Lens.get(item, args[0] as any), idx: i }));
                            sortKeyed(keyed, dir, nullish);
                            return keyed.map((e) => e.item);
                        };
                        const nextFilters = [...filters, { type: "sort" as const, args }];
                        if (isEach) return createProxy({ value: (value as any[]).map(sortArr), isEach: true, path, filters: nextFilters });
                        return createProxy({ value: sortArr(value as any[]), isEach: false, path, filters: nextFilters });
                    };
                case "slice":
                    return (rawStart: number, rawEnd?: number) => {
                        const start = unwrap(rawStart) as number;
                        const end = rawEnd !== undefined ? (unwrap(rawEnd) as number) : undefined;
                        const nextFilters = [...filters, { type: "slice" as const, start, end }];
                        if (isEach) return createProxy({ value: (value as any[]).map((v: any[]) => v.slice(start, end)), isEach: true, path, filters: nextFilters });
                        return createProxy({ value: (value as any[]).slice(start, end), isEach: false, path, filters: nextFilters });
                    };
                //#endregion

                //#region - Logical combinators
                case "or":
                    return (...preds: any[]) => ({ [PRED]: preds.some((p) => evalPredicate(p)) });
                case "and":
                    return (...preds: any[]) => ({ [PRED]: preds.every((p) => evalPredicate(p)) });
                case "not":
                    return (pred: any) => ({ [PRED]: !evalPredicate(pred) });
                case "xor":
                    return (...preds: any[]) => ({ [PRED]: preds.filter((p) => evalPredicate(p)).length % 2 === 1 });
                //#endregion
            }

            //#region - Custom accessor dispatch
            if (typeof prop === "string") {
                // Custom accessors (LensNav — object protocol)
                const customDispatch = (v: any): ((...args: any[]) => unknown) | undefined => {
                    const accessor = v?.[TrhSymbols.LensNav]?.[prop];
                    return accessor && typeof accessor.select === "function" ? (...args: any[]) => accessor.select(...args) : undefined;
                };

                if (isEach) {
                    const hasAny = (value as any[]).some((v) => customDispatch(v));
                    if (hasAny)
                        return (...rawArgs: any[]) => {
                            const args = rawArgs.map(unwrap);
                            return createProxy({
                                value: (value as any[]).map((v) => customDispatch(v)?.(...args)),
                                isEach: true,
                                path: [...path, { type: "custom" as const, prop, args }],
                                filters: [],
                            });
                        };
                } else {
                    const fn = customDispatch(value);
                    if (fn)
                        return (...rawArgs: any[]) => {
                            const args = rawArgs.map(unwrap);
                            return nav(() => fn(...args), { type: "custom", prop, args });
                        };
                }
            }
            //#endregion

            return undefined;
        },
    };

    return new Proxy(function () {}, handler);
}

//#endregion

//#region - Replay (mutate / apply)

const wrapValue = (item: any): any => createProxy({ value: item, isEach: false, path: [], filters: [] });

function parseSortArgs(args: any[]): { dir: string; nullish: string } {
    const dirOrConfig = args[1];
    return {
        dir: typeof dirOrConfig === "string" ? dirOrConfig : (dirOrConfig?.direction ?? "asc"),
        nullish: typeof dirOrConfig === "object" ? (dirOrConfig?.nullish ?? "last") : "last",
    };
}

function sortKeyed<T extends { key: unknown; idx: number }>(keyed: T[], dir: string, nullish: string): void {
    keyed.sort((a, b) => {
        const aN = a.key === null || a.key === undefined;
        const bN = b.key === null || b.key === undefined;
        if (aN || bN) {
            if (aN && bN) return a.idx - b.idx;
            if (aN) return nullish === "first" ? -1 : 1;
            return nullish === "first" ? 1 : -1;
        }
        const cmp = sortCompare(a.key, b.key);
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
        return a.idx - b.idx;
    });
}

function resolveAtIndex(arr: any[], step: { index: number; filters?: FilterOp[] }): number {
    if (step.filters?.length) {
        const indices = matchingIndices(arr, step.filters);
        const fi = step.index < 0 ? indices.length + step.index : step.index;
        return indices[fi];
    }
    return step.index < 0 ? arr.length + step.index : step.index;
}

function resolveCallbackPath(step: { callback: Function }, item: any, steps: PathStep[], next: number): PathStep[] {
    const elProxy = wrapValue(item);
    const subResult = step.callback(elProxy);
    const subPath = (subResult as any)[LENS].path as PathStep[];
    return [...subPath, ...steps.slice(next)];
}

// Resolve which original indices in `arr` match a chain of accumulated filters
function matchingIndices(arr: any[], ops: FilterOp[]): number[] {
    let indices = Array.from({ length: arr.length }, (_, i) => i);
    for (const f of ops) {
        switch (f.type) {
            case "where":
                indices = indices.filter((i) => evalPredicate(f.predFn(wrapValue(arr[i]))));
                break;
            case "filter":
                indices = indices.filter((i) => (f.fn as Function)(arr[i]));
                break;
            case "slice": {
                const s = f.start < 0 ? Math.max(0, indices.length + f.start) : f.start;
                const e = f.end !== undefined ? (f.end < 0 ? Math.max(0, indices.length + f.end) : f.end) : indices.length;
                indices = indices.slice(s, e);
                break;
            }
            case "sort": {
                const args = f.args;
                if (typeof args[0] === "function" && args.length === 1) {
                    // Comparator overload
                    indices.sort((a, b) => args[0](arr[a], arr[b]));
                } else {
                    const { dir, nullish } = parseSortArgs(args);
                    const keyed = indices.map((i, idx) => ({ i, key: Lens.get(arr[i], args[0] as any), idx }));
                    sortKeyed(keyed, dir, nullish);
                    indices = keyed.map((e) => e.i);
                }
                break;
            }
        }
    }
    return indices;
}

const seg = {
    prop: (key: string): LensPathSegment => ({ type: "property", key }),
    idx: (index: number): LensPathSegment => ({ type: "index", index }),
    acc: (name: string, ...args: string[]): LensPathSegment => (args.length > 0 ? { type: "accessor", name, args } : { type: "accessor", name }),
    fromPropStep: (key: string | number): LensPathSegment => (typeof key === "number" ? seg.idx(key) : seg.prop(key)),
};

function doApply(current: any, steps: PathStep[], idx: number, updater: (prev: any, index: number, ctx: Lens.Context) => any, ctx: Lens.Context): any {
    if (idx >= steps.length) return updater(current, ctx.index, ctx);

    const step = steps[idx];
    const next = idx + 1;

    switch (step.type) {
        case "prop": {
            const childCtx = { ...ctx, path: [...ctx.path, seg.fromPropStep(step.key)] };
            const child = doApply(current[step.key], steps, next, updater, childCtx);
            if (Array.isArray(current)) {
                const result = [...current];
                result[step.key as number] = child;
                return result;
            }
            return { ...current, [step.key]: child };
        }
        case "at": {
            const resolved = resolveAtIndex(current, step);
            const childCtx = { ...ctx, path: [...ctx.path, seg.idx(resolved)] };
            const child = doApply(current[resolved], steps, next, updater, childCtx);
            const result = [...current];
            result[resolved] = child;
            return result;
        }
        case "each": {
            if (step.callback) {
                const applyToElement = (item: any, j: number, count: number) => {
                    const fullPath = resolveCallbackPath(step as { callback: Function }, item, steps, next);
                    return doApply(item, fullPath, 0, updater, { path: [...ctx.path, seg.idx(j)], index: j, count });
                };
                if (step.filters?.length) {
                    const indices = matchingIndices(current, step.filters);
                    const result = [...current];
                    for (let j = 0; j < indices.length; j++) {
                        result[indices[j]] = applyToElement(current[indices[j]], j, indices.length);
                    }
                    return result;
                }
                return (current as any[]).map((item: any, j: number) => applyToElement(item, j, current.length));
            }
            if (step.filters?.length) {
                const indices = matchingIndices(current, step.filters);
                const result = [...current];
                for (let j = 0; j < indices.length; j++) {
                    const i = indices[j];
                    const childCtx = { path: [...ctx.path, seg.idx(i)], index: j, count: indices.length };
                    result[i] = doApply(current[i], steps, next, updater, childCtx);
                }
                return result;
            }
            return (current as any[]).map((item: any, j: number) => doApply(item, steps, next, updater, { path: [...ctx.path, seg.idx(j)], index: j, count: current.length }));
        }
        case "mapGet": {
            const map = new Map(current as Map<any, any>);
            const childCtx = { ...ctx, path: [...ctx.path, seg.acc("get", String(step.key))] };
            map.set(step.key, doApply(map.get(step.key), steps, next, updater, childCtx));
            return map;
        }
        case "custom": {
            const accessor = current?.[TrhSymbols.LensNav]?.[step.prop];
            if (accessor?.select) {
                const childCtx = { ...ctx, path: [...ctx.path, seg.acc(step.prop, ...step.args.map(String))] };
                const readValue = accessor.select(...step.args);
                const newValue = doApply(readValue, steps, next, updater, childCtx);
                return accessor.apply?.(newValue, ...step.args) ?? current;
            }
            return current;
        }
    }
}

function doMutate(current: any, steps: PathStep[], idx: number, updater: (prev: any, index: number, ctx: Lens.Context) => any, ctx: Lens.Context): void {
    const step = steps[idx];
    const next = idx + 1;
    const atLeaf = next >= steps.length;

    // For plain property/index steps, descend or apply at leaf
    const descend = (parent: any, key: string | number, childCtx: Lens.Context) => {
        if (atLeaf) parent[key] = updater(parent[key], childCtx.index, childCtx);
        else doMutate(parent[key], steps, next, updater, childCtx);
    };

    switch (step.type) {
        case "prop":
            descend(current, step.key, { ...ctx, path: [...ctx.path, seg.fromPropStep(step.key)] });
            break;
        case "at": {
            const resolved = resolveAtIndex(current, step);
            descend(current, resolved, { ...ctx, path: [...ctx.path, seg.idx(resolved)] });
            break;
        }
        case "each": {
            if (step.callback) {
                const mutateElement = (arr: any[], i: number, j: number, count: number) => {
                    const fullPath = resolveCallbackPath(step as { callback: Function }, arr[i], steps, next);
                    doMutate(arr[i], fullPath, 0, updater, { path: [...ctx.path, seg.idx(i)], index: j, count });
                };
                if (step.filters?.length) {
                    const indices = matchingIndices(current, step.filters);
                    for (let j = 0; j < indices.length; j++) {
                        mutateElement(current, indices[j], j, indices.length);
                    }
                } else {
                    for (let i = 0; i < current.length; i++) {
                        mutateElement(current, i, i, current.length);
                    }
                }
                break;
            }
            if (step.filters?.length) {
                const indices = matchingIndices(current, step.filters);
                for (let j = 0; j < indices.length; j++) {
                    const i = indices[j];
                    descend(current, i, { path: [...ctx.path, seg.idx(i)], index: j, count: indices.length });
                }
            } else {
                for (let i = 0; i < current.length; i++) {
                    descend(current, i, { path: [...ctx.path, seg.idx(i)], index: i, count: current.length });
                }
            }
            break;
        }
        case "mapGet": {
            const map = current as Map<any, any>;
            const childCtx = { ...ctx, path: [...ctx.path, seg.acc("get", String(step.key))] };
            if (atLeaf) map.set(step.key, updater(map.get(step.key), ctx.index, childCtx));
            else doMutate(map.get(step.key), steps, next, updater, childCtx);
            break;
        }
        case "custom": {
            const accessor = current?.[TrhSymbols.LensNav]?.[step.prop];
            if (accessor?.select) {
                const childCtx = { ...ctx, path: [...ctx.path, seg.acc(step.prop, ...step.args.map(String))] };
                const readValue = accessor.select(...step.args);
                if (atLeaf) accessor.mutate?.(updater(readValue, ctx.index, childCtx), ...step.args);
                else accessor.mutate?.(doApply(readValue, steps, next, updater, childCtx), ...step.args);
            }
            break;
        }
    }
}

//#endregion

type SortDirection = "asc" | "desc" | { direction: "asc" | "desc"; nullish?: "first" | "last" };

//#region - Unified DataLens

// DataLens<Target, Eval, Chain>
//   Target = what the updater receives for mutation (never = can't be terminal)
//   Eval   = what Lens.get returns (tracks array wrapping from each())
//   Chain  = current navigation type (what properties/methods are available)

type DataLens<Target, Eval = Target, Chain = Eval> = {
    readonly [BRAND_TARGET]: Target;
    readonly [BRAND_EVAL]: Eval;

    // Always available — read-only (Target = never)
    transform<R>(transformer: (subject: NonNullable<Chain>) => R): DataLens<never, WrapEval<Eval, Chain, R>, R>;
} & ([Target] extends [never] ? { readonly [BRAND_READONLY]: true } : {}) & // Readonly marker: when Target = never, adds a brand that structurally conflicts with MutatorLensOf/ApplierLensOf
    // String
    (NonNullable<Chain> extends string
        ? {
              size(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
          }
        : {}) &
    // Array
    (NonNullable<Chain> extends (infer E)[] | readonly (infer E)[]
        ? {
              (index: number | SelectorLensOf<number>): DataLens<WrapTarget<Target, Chain, E>, WrapEval<Eval, Chain, E>, E>;
              at(index: number | SelectorLensOf<number>): DataLens<WrapTarget<Target, Chain, E>, WrapEval<Eval, Chain, E>, E>;
              each(): DataLens<E, E[], E>;
              each<RT, RE>(callback: ($el: DataLens<E, E, E>) => DataLens<RT, RE, any>): DataLens<WrapTarget<Target, Chain, RT>, RE[], RE>;
              where(pred: ($: DataLens<never, ElementOf<Chain>> & LogicalOps) => Predicate<any> | PredicateResult): DataLens<never, Eval, Chain>;
              filter(fn: (item: ElementOf<Chain>) => boolean): DataLens<never, Eval, Chain>;
              slice(start: number | SelectorLensOf<number>, end?: number | SelectorLensOf<number>): DataLens<never, Eval, Chain>;
              sort<R extends string | number | bigint | TrhSymbols.Comparable | null | undefined>(
                  target: ($: DataLens<never, ElementOf<Chain>>) => SelectorLensOf<R>,
                  dir: SortDirection,
              ): DataLens<never, Eval, Chain>;
              sort(comparator: (a: E, b: E) => number): DataLens<never, Eval, Chain>;
              size(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
              length(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
          }
        : {}) &
    // Any-object (string key access)
    (NonNullable<Chain> extends object
        ? {
              <Key extends AllStringKeys<Chain>>(key: Key): DataLens<KeepTarget<Target, Chain, SafeLookup<Chain, Key>>, WrapEval<Eval, Chain, SafeLookup<Chain, Key>>, SafeLookup<Chain, Key>>;
          }
        : {}) &
    // Plain-ish Object (not array)
    (NonNullable<Chain> extends Record<string, infer V>
        ? NonNullable<Chain> extends any[]
            ? never
            : {
                  keys(): DataLens<never, WrapEval<Eval, Chain, string[]>, string[]>;
                  values(): DataLens<never, WrapEval<Eval, Chain, V[]>, V[]>;
                  entries(): DataLens<never, WrapEval<Eval, Chain, [string, V][]>, [string, V][]>;
                  size(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
              }
        : {}) &
    // Set
    (NonNullable<Chain> extends Set<infer SV>
        ? {
              has(value: SV | SelectorLensOf<SV>): DataLens<never, WrapEval<Eval, Chain, boolean>, boolean>;
              size(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
          }
        : {}) &
    // Map
    (NonNullable<Chain> extends Map<infer MK, infer MV>
        ? {
              get(key: MK | SelectorLensOf<MK>): DataLens<KeepTarget<Target, Chain, MV>, WrapEval<Eval, Chain, MV>, MV>;
              has(key: MK | SelectorLensOf<MK>): DataLens<never, WrapEval<Eval, Chain, boolean>, boolean>;
              keys(): DataLens<never, WrapEval<Eval, Chain, MK[]>, MK[]>;
              values(): DataLens<never, WrapEval<Eval, Chain, MV[]>, MV[]>;
              entries(): DataLens<never, WrapEval<Eval, Chain, [MK, MV][]>, [MK, MV][]>;
              size(): DataLens<never, WrapEval<Eval, Chain, number>, number>;
          }
        : {}) &
    // Custom accessors (LensNav — object protocol with select/mutate?/apply?)
    (NonNullable<Chain> extends { [TrhSymbols.LensNav]: infer Methods }
        ? {
              [M in keyof Methods]: Methods[M] extends { select: (...args: infer A) => infer VT }
                  ? (...args: MapSelectorLensOf<A>) => DataLens<Methods[M] extends { mutate: any } | { apply: any } ? KeepTarget<Target, Chain, VT> : never, WrapEval<Eval, Chain, VT>, VT>
                  : never;
          }
        : {});

//#endregion

//#region - Helpers

type ElementOf<T> = NonNullable<T> extends (infer E)[] | readonly (infer E)[] ? E : never;

// Maps each tuple element T[K] to T[K] | SelectorLensOf<T[K]> — allows lens args at any position
type MapSelectorLensOf<T extends any[]> = { [K in keyof T]: T[K] | SelectorLensOf<T[K]> };

// Eval wrapping: if Eval ≠ Chain (after each()), wrap result in array
type WrapEval<Eval, Chain, NewChain> = [Eval] extends [Chain] ? NewChain : NewChain[];

// Target cardinality: same logic as WrapEval but applied to Target
// Note: [never] extends [T] is always true, so WrapTarget on never yields the unwrapped type.
// This is intentional: array at()/$(n) should restore Target after where/filter (which set Target = never).
type WrapTarget<Target, Chain, NewChain> = [Target] extends [Chain] ? NewChain : NewChain[];

// Target propagation for non-restoring navigation (object property access, Map.get, custom accessors):
// If Target is never (from read-only ops or where/filter/slice/sort), keep it never.
// Otherwise, apply cardinality wrapping.
type KeepTarget<Target, Chain, NewChain> = [Target] extends [never] ? never : WrapTarget<Target, Chain, NewChain>;

declare const BRAND_TARGET: unique symbol;
declare const BRAND_EVAL: unique symbol;
declare const BRAND_READONLY: unique symbol;

// Output types — what the lens callback must return
// MutatorLensOf/ApplierLensOf require BRAND_READONLY to be absent (?: never).
// DataLens with Target = never adds { [BRAND_READONLY]: true }, creating a structural mismatch.
export type SelectorLensOf<E> = { readonly [BRAND_EVAL]: E };
export type MutatorLensOf<E> = { readonly [BRAND_TARGET]: E; readonly [BRAND_READONLY]?: never };
export type ApplierLensOf<E> = { readonly [BRAND_TARGET]: E; readonly [BRAND_READONLY]?: never };

// Backward compatibility aliases — all three are now DataLens
export type SelectorLens<Eval, Chain = Eval> = DataLens<Eval, Eval, Chain>;
export type MutatorLens<Target, Chain = Target> = DataLens<Target, Target, Chain>;
export type ApplierLens<Target, Chain = Target> = DataLens<Target, Target, Chain>;

//#endregion

// Result of a combinator expression — opaque marker type
declare const PREDICATE_BRAND: unique symbol;
type PredicateResult = { readonly [PREDICATE_BRAND]: true };

type LogicalOps = {
    or(...conditions: (Predicate<any> | PredicateResult)[]): PredicateResult;
    and(...conditions: (Predicate<any> | PredicateResult)[]): PredicateResult;
    not(condition: Predicate<any> | PredicateResult): PredicateResult;
    xor(...conditions: (Predicate<any> | PredicateResult)[]): PredicateResult;
};

// --- Operator catalog ---

// Equality: any type
type EqualityOp = "=" | "!=" | "==" | "!==";

// Ordering: number, bigint, string, or Comparable
type OrderingOp = ">" | "!>" | ">=" | "!>=" | "<" | "!<" | "<=" | "!<=";

// Any-of equality: value matches any/none in array
type EqualityAnyOfOp = "=|" | "!=|";

// Range: 4-member predicates only
type RangeOp = "><" | "!><" | ">=<" | "!>=<";

// String: contains, starts/ends with, case sensitive/insensitive
type StringContainsOp = "%" | "!%" | "%^" | "!%^";
type StringStartsWithOp = "%_" | "!%_" | "%^_" | "!%^_";
type StringEndsWithOp = "_%" | "!_%" | "_%^" | "!_%^";
type StringAnyOfOp = "%|" | "!%|" | "%^|" | "!%^|" | "%_|" | "!%_|" | "_%|" | "!_%|";
type StringAllOfOp = "%&" | "!%&" | "%^&" | "!%^&";
type StringOp = StringContainsOp | StringStartsWithOp | StringEndsWithOp;

// Regex: match against RegExp
type RegexOp = "~" | "!~";
type RegexAnyOfOp = "~|" | "!~|";
type RegexAllOfOp = "~&" | "!~&";

// Array has: array contains element(s)
type HasOp = "#" | "!#";
type HasAnyOfOp = "#|" | "!#|";
type HasAllOfOp = "#&" | "!#&";

// Typeof: runtime type check (RHS is string, not a closed union — users can register custom type descriptors)
type TypeofOp = ":" | "!:";
type TypeofAnyOfOp = ":|" | "!:|";

// --- Operator → type mapping (parameterized by arity) ---

// Unary: no operand (truthiness check)
type UnaryOp = "?" | "!?";

// A = 2: unary ops; A = 3: standard ops; A = 4: range ops only
export type OperatorFor<O, A extends 2 | 3 | 4> = A extends 4
    ? O extends number | bigint | string | TrhSymbols.Comparable
        ? RangeOp
        : never
    : A extends 2
      ? UnaryOp
      : // A extends 3
            | EqualityOp
            | EqualityAnyOfOp
            | TypeofOp
            | TypeofAnyOfOp
            | (O extends number | bigint | string | TrhSymbols.Comparable ? OrderingOp : never)
            | (O extends string ? StringOp | StringAnyOfOp | StringAllOfOp | RegexOp | RegexAnyOfOp | RegexAllOfOp : never)
            | (O extends any[] | Set<any> | TrhSymbols.Containable<any> ? HasOp | HasAnyOfOp | HasAllOfOp : never);

// --- Operand type mapping ---

// Ops that take an array of values as RHS (any-of / all-of)
type AnyOfOp = EqualityAnyOfOp | StringAnyOfOp | StringAllOfOp | RegexAnyOfOp | RegexAllOfOp | HasAnyOfOp | HasAllOfOp | TypeofAnyOfOp;

// Map from operator to valid operand type
type OperandFor<O, Op> =
    // Typeof: RHS is string
    Op extends TypeofOp
        ? string
        : Op extends TypeofAnyOfOp
          ? string[]
          : // Regex: RHS is RegExp
            Op extends RegexOp
            ? RegExp
            : Op extends RegexAnyOfOp | RegexAllOfOp
              ? RegExp[]
              : // Array contains: RHS is element type
                Op extends HasOp
                ? O extends (infer E)[]
                    ? E | SelectorLens<E>
                    : O extends Set<infer E>
                      ? E | SelectorLens<E>
                      : O extends TrhSymbols.Containable<infer E>
                        ? E | SelectorLens<E>
                        : never
                : Op extends HasAnyOfOp | HasAllOfOp
                  ? O extends (infer E)[]
                      ? (E | SelectorLens<E>)[]
                      : O extends Set<infer E>
                        ? (E | SelectorLens<E>)[]
                        : O extends TrhSymbols.Containable<infer E>
                          ? (E | SelectorLens<E>)[]
                          : never
                  : // Any-of / all-of: RHS is array of O
                    Op extends AnyOfOp
                    ? (O | SelectorLens<O>)[]
                    : // Default: RHS is O
                          O | SelectorLens<O>;

// --- The Predicate tuple ---

type Predicate<O> =
    | [subject: O | SelectorLensOf<O>, op: NoInfer<OperatorFor<O, 2>>]
    | [subject: O | SelectorLensOf<O>, op: NoInfer<OperatorFor<O, 3>>, operand: NoInfer<OperandFor<O, OperatorFor<O, 3>>> | SelectorLensOf<any>]
    | [
          subject: O | SelectorLensOf<O>,
          op: NoInfer<OperatorFor<O, 4>>,
          operand1: NoInfer<OperandFor<O, OperatorFor<O, 4>>> | SelectorLensOf<any>,
          operand2: NoInfer<OperandFor<O, OperatorFor<O, 4>>> | SelectorLensOf<any>,
      ];
