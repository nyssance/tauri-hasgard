# Security

Tauri Hasgard is a development and test dependency. Registering the plugin enables automation in every build, release builds included: it exposes script evaluation and Tauri IPC to local clients of its endpoint. Never register it in a production build; add the `.plugin(...)` call conditionally in your application.

Report vulnerabilities privately to the repository owner before opening a public issue.
