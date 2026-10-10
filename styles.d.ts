// A control's stylesheet is a real `.css` file that `osy control build` inlines as TEXT (esbuild
// `--loader:.css=text`), so the shim receives its contents as a string and injects it. This tells `tsc` the same
// thing, since the type-check runs without esbuild and would otherwise refuse the import.
declare module '*.css' {
  const css: string;
  export default css;
}
