import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"], // only index.ts
    format: ["esm", "cjs"], // or just one, like ['esm']
    clean: true, // clean dist before build
    dts: true, // generate type declarations
    outDir: "dist", // output directory
    shims: false, // disable nodejs shims (optional)
    treeshake: true, // helps remove unused exports
    minify: false, // optional: you can enable if needed
    deps: {
        neverBundle: [],
    },
    target: false,
});
