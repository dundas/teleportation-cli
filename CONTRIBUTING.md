# Contributing to Teleportation CLI

Thank you for your interest in contributing! 🎉

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/teleportation-cli.git
   cd teleportation-cli
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run tests:
   ```bash
   npm test
   ```

## Development

### Project Structure

```
teleportation-cli/
├── lib/
│   ├── cli/               # CLI command implementations
│   ├── auth/              # Authentication & encryption
│   ├── config/            # Configuration management
│   └── session/           # Session handling
├── .claude/
│   └── hooks/             # Claude Code hooks
├── scripts/
│   └── install.sh         # Installation script
├── teleportation-cli.cjs  # Main CLI entry point
└── tests/                 # Test files
```

### Running Locally

```bash
# Link the CLI globally for testing
npm link

# Now you can use the command
teleportation --help
```

### Code Style

- Use ES modules (`.js` with `type: "module"`)
- Follow existing code patterns
- Add JSDoc comments for public functions
- Keep dependencies minimal (prefer Node.js built-ins)

## Submitting Changes

1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit:
   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

3. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Open a Pull Request

### Commit Messages

We use conventional commits:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `chore:` Maintenance
- `test:` Tests

## Reporting Issues

- Search existing issues first
- Include reproduction steps
- Include your environment (Node version, OS)

## Questions?

Open an issue with the `question` label.

Thank you for contributing! 🚀

