import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { copyFileSync, existsSync } from 'fs';

// Copy snarkjs to public/ so prover-worker.js can importScripts('snarkjs.min.js')
function copySnarkjs() {
  return {
    name: 'copy-snarkjs',
    buildStart() {
      const src = 'node_modules/snarkjs/build/snarkjs.min.js';
      const dst = 'public/snarkjs.min.js';
      if (existsSync(src)) copyFileSync(src, dst);
    },
  };
}

// @harmoniclabs/cbor is a CJS package with internal circular dependencies that
// Rollup's CJS-to-ESM transform resolves in the wrong order: CborString module
// calls into the Cbor encoder at init time, which eventually needs SubCborRef,
// which tries to extend CborString — but CborString hasn't finished initialising
// yet, so it's undefined. esbuild handles CJS circular deps correctly by
// processing all files in a single pass and emitting them in the right order.
// This plugin runs only in production builds and pre-bundles @harmoniclabs/cbor
// using esbuild, keeping its @harmoniclabs/* peer deps as ESM externals so
// Rollup can tree-shake and deduplicate them normally.
function prebundleHarmonicabs() {
  let prebundledCode = null;

  return {
    name: 'prebundle-harmoniclabs-cbor',
    apply: 'build',
    enforce: 'pre',

    async buildStart() {
      const esbuild = await import('esbuild');
      const result = await esbuild.build({
        entryPoints: ['@harmoniclabs/cbor'],
        bundle: true,
        format: 'esm',
        // Bundle all @harmoniclabs/* deps into the pre-bundle — keeping them
        // external leaves CJS require() calls that break in ESM browser context.
        write: false,
        platform: 'browser',
        target: 'esnext',
      });
      prebundledCode = result.outputFiles[0].text;
    },

    resolveId(id) {
      if (id === '@harmoniclabs/cbor') return '\0harmoniclabs-cbor';
    },

    load(id) {
      if (id === '\0harmoniclabs-cbor') return prebundledCode;
    },
  };
}

export default defineConfig({
  base: '/aiken-plonk/',
  plugins: [
    prebundleHarmonicabs(),
    // wasm() must come before nodePolyfills so WASM imports are resolved first
    wasm(),
    nodePolyfills(),
    copySnarkjs(),
    // NOTE: vite-plugin-top-level-await is intentionally omitted.
    // With target:'esnext' the browser handles TLA natively; the plugin's
    // synthetic-promise transformation breaks CML's WASM init order.
  ],
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      // @cardano-sdk/util imports `lodash/isEqual.js` as an ESM default, but lodash is CJS.
      // Redirecting to lodash-es gives proper ESM modules with real default exports.
      'lodash': 'lodash-es',
    },
  },
  optimizeDeps: {
    // Exclude only the WASM-containing packages from esbuild pre-bundling.
    // esbuild can't process `import * as wasm from "*.wasm"` — vite-plugin-wasm
    // handles those at Vite's module-server level instead.
    // All other Lucid deps (including CJS packages like bech32, @cardano-sdk/*)
    // ARE pre-bundled by esbuild so they get proper ESM wrappers.
    exclude: [
      '@anastasia-labs/cardano-multiplatform-lib-browser',
      '@emurgo/cardano-message-signing-browser',
      '@lucid-evolution/uplc',
      'wasmcurves',
    ],
    esbuildOptions: { target: 'esnext' },
  },
});
