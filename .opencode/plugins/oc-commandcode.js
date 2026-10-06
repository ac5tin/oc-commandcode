// Dev-only loader stub so this repo dogfoods its own plugin via .opencode/plugins discovery.
// Installs use package.json main -> dist/oc-commandcode.js (dot-dirs are stripped by git-dep packing).
export { default } from "../../dist/oc-commandcode.js"
