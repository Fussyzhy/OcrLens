/// <reference types="vite/client" />

// Note: no `declare module '*.vue'` shim here on purpose. vue-tsc infers SFC
// types directly, and a wildcard declaration would shadow that inference and
// silently drop prop type checking.
