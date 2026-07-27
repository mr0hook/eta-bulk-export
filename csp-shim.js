// Runs in the MAIN world BEFORE ExcelJS. The ExcelJS bundle carries regenerator-runtime, whose
// global-install does: try { regeneratorRuntime = rt } catch { Function("r","regeneratorRuntime=r")(rt) }.
// In a world:MAIN content script that assignment is a strict-mode undeclared-global write, so it throws
// and falls back to Function()/eval, which the ETA portal's CSP (no 'unsafe-eval') blocks with an
// EvalError. Pre-creating the property makes the assignment target an existing global, so it succeeds and
// the eval branch is never reached. Keeps the vendored ExcelJS pristine and adds no eval of our own.
if (!('regeneratorRuntime' in window)) window.regeneratorRuntime = void 0;
