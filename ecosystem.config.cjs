module.exports = {
  apps: [
    {
      name: "tunnel-server",
      script: "server/server.ts",
      interpreter: "bun",
      cwd: __dirname,
      env: {
        PORT: "8080",
        DOMAIN: "faiezwaseem.site",
        DB_PATH: "./data/tunnel.db",
        REQUEST_TIMEOUT_MS: "30000",
        INITIAL_ADMIN_USERNAME: "",
        INITIAL_ADMIN_PASSWORD: "",
      },
    },
  ],
};
