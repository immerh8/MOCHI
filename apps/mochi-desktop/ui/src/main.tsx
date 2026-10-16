import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { QuickWindow } from "./quick/QuickWindow";
import "./styles.css";

// The shell's quick verbs open a small second window on the same page, told
// apart by the fragment Rust gives its URL (src-tauri/src/lib.rs).
const compact = window.location.hash === "#quick";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{compact ? <QuickWindow /> : <App />}</StrictMode>);
}
