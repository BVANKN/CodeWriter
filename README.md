# CodeWriter backend

This folder is the standalone Render service and the only Git repository in the project.

```bash
npm install
npm test
npm start
```

Render must advertise `https://codewriter-38cb.onrender.com` as `PUBLIC_URL`. The public MCP endpoint is `https://codewriter-38cb.onrender.com/mcp`; local folders are served through the outbound desktop WebSocket bridge.
