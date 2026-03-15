import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"], // only index.ts
    format: ["esm", "cjs"], // or just one, like ['esm']
    splitting: false, // required for bundling into one file
    clean: true, // clean dist before build
    dts: true, // generate type declarations
    bundle: true, // enables bundling
    outDir: "dist", // output directory
    shims: false, // disable nodejs shims (optional)
    treeshake: true, // helps remove unused exports
    external: [], // list any deps you want to exclude from the bundle
    minify: false, // optional: you can enable if needed
});
