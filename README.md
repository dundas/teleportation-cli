# Teleportation CLI

[![npm version](https://img.shields.io/npm/v/@teleportation/cli.svg)](https://www.npmjs.com/package/@teleportation/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Remote approval system for Claude Code** — approve AI coding changes from your phone.

Work continues while you're away. ☕

## What is Teleportation?

Teleportation intercepts Claude Code tool requests and routes them to your phone for approval. This means you can:

- 🏃 **Step away** from your computer while Claude works
- 📱 **Approve changes** from anywhere via mobile
- 🔒 **Stay in control** of what code gets executed
- ⚡ **Keep working** without being tethered to your desk

## Installation

### Quick Install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/dundas/teleportation-cli/main/scripts/install.sh | bash
```

### npm

```bash
npm install -g @teleportation/cli
```

### From Source

```bash
git clone https://github.com/dundas/teleportation-cli.git
cd teleportation-cli
npm link
```

## Requirements

- **Node.js 20+**
- **Claude Code** installed

## Quick Start

```bash
# 1. Enable remote approvals
teleportation on

# 2. Log in to your account
teleportation login

# 3. Check status
teleportation status

# 4. Start Claude Code - approvals will appear on your phone! 📱
```

## Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `teleportation on` | Enable remote approval hooks |
| `teleportation off` | Disable hooks (local mode) |
| `teleportation status` | Show current configuration |
| `teleportation login` | Authenticate with relay server |
| `teleportation logout` | Clear credentials |
| `teleportation help` | Show all commands |

### Session Management

```bash
teleportation session list       # List active sessions
teleportation session info       # Show current session details
teleportation session pause      # Pause current session
teleportation session resume     # Resume paused session
teleportation session complete   # Mark session complete
teleportation session cleanup    # Clean up old sessions
```

### Worktrees (Multi-session isolation)

```bash
teleportation worktree create <name>   # Create isolated worktree
teleportation worktree list            # List all worktrees
teleportation worktree use <name>      # Switch to worktree
teleportation worktree merge <name>    # Merge worktree changes
teleportation worktree remove <name>   # Remove worktree
```

### Snapshots (Code checkpoints)

```bash
teleportation snapshot create <name>   # Create code snapshot
teleportation snapshot list            # List snapshots
teleportation snapshot restore <name>  # Restore to snapshot
teleportation snapshot diff <name>     # Compare with snapshot
teleportation snapshot delete <name>   # Delete snapshot
```

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Claude Code   │────▶│   Relay API     │────▶│   Your Phone    │
│   (Your Mac)    │     │   (Cloud)       │     │   (Anywhere)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                               │
        │ 1. Tool request intercepted                   │
        │                                               │
        │                    2. Pushed to your phone    │
        │                                               │
        │                    3. You approve/deny 👆     │
        │                                               │
        │ 4. Claude continues or stops ◀────────────────┘
```

1. **Hooks intercept** Claude Code tool requests
2. **Relay routes** requests to the mobile UI
3. **You decide** from your phone
4. **Claude responds** based on your decision

## Configuration

Configuration is stored in `~/.teleportation/`:

```
~/.teleportation/
├── config.json           # User preferences
├── credentials.enc       # Encrypted credentials (AES-256)
└── bin/
    └── teleportation     # CLI symlink
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEPORTATION_RELAY_URL` | Custom relay server URL |
| `TELEPORTATION_API_KEY` | API key for authentication |

## Security

- 🔐 **AES-256 encryption** for stored credentials
- 🔑 **OAuth authentication** via Google/GitHub
- 🏠 **Multi-tenant isolation** — your data stays yours
- 👻 **Privacy-preserving** — session existence not leaked

## Troubleshooting

### Hooks not working?

```bash
# Check if hooks are installed
teleportation status

# Reinstall hooks
teleportation off && teleportation on
```

### Authentication issues?

```bash
# Clear and re-authenticate
teleportation logout
teleportation login
```

### Check logs

```bash
# View daemon logs
cat ~/.teleportation/daemon.log
```

## Documentation

- 📖 [Full Documentation](https://teleportation.dev/docs)
- 🚀 [Getting Started Guide](https://teleportation.dev/docs/getting-started)
- ❓ [FAQ](https://teleportation.dev/docs/faq)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

```bash
# Clone and set up development environment
git clone https://github.com/dundas/teleportation-cli.git
cd teleportation-cli
npm install
npm test
```

## License

MIT © [Dundas](https://github.com/dundas)

## Links

- [GitHub](https://github.com/dundas/teleportation-cli)
- [npm](https://www.npmjs.com/package/@teleportation/cli)
- [Documentation](https://teleportation.dev)
- [Report Issues](https://github.com/dundas/teleportation-cli/issues)

