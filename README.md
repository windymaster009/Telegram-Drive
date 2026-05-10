# Telegram Drive Backend

This folder contains the Tauri/Rust backend, the local REST API, authentication, authorization, Telegram business logic, and persistence code.

## Run Locally

From this folder:

```bash
cargo run
```

This runs the lightweight backend HTTP API without opening the Tauri desktop window.

From the repository root, the equivalent command is:

```bash
npm run dev:api
```

If the backend dev command says Cargo is missing, install Rust from https://rustup.rs/, restart your terminal, and verify:

```bash
cargo --version
rustc --version
```

For the full setup guide, see the root `README.md`.
