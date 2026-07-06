// Compatibility shim — kept so existing deployments keep working unchanged:
//   node index.js                 (systemd units created by server-setup)
//   pm2 start ecosystem.config.cjs (script: "index.js")
// The real implementation lives in dist/ (TypeScript, built by `npm run build`).
import "./dist/index.js";
