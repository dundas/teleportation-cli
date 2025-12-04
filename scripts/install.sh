#!/bin/sh
# Teleportation Installer
# Usage: curl -fsSL https://get.teleportation.dev | bash

set -e

REPO="https://github.com/dundas/teleportation-cli.git"
INSTALL_DIR="$HOME/.teleportation-cli"
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "${CYAN}╭─────────────────────────────────────────────────────╮${NC}"
echo "${CYAN}│                                                     │${NC}"
echo "${CYAN}│   ${GREEN}⚡ Teleportation Installer${CYAN}                        │${NC}"
echo "${CYAN}│                                                     │${NC}"
echo "${CYAN}│   Remote approval system for Claude Code            │${NC}"
echo "${CYAN}│                                                     │${NC}"
echo "${CYAN}╰─────────────────────────────────────────────────────╯${NC}"
echo ""

# Check for required tools
check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# Detect package manager / runtime
RUNTIME=""
if check_command bun; then
    RUNTIME="bun"
    echo "${GREEN}✓${NC} Found Bun"
elif check_command node; then
    RUNTIME="node"
    echo "${GREEN}✓${NC} Found Node.js $(node -v)"
else
    echo "${RED}✗${NC} Error: Node.js or Bun is required"
    echo ""
    echo "  Install Node.js: https://nodejs.org/"
    echo "  Install Bun:     curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

if ! check_command git; then
    echo "${RED}✗${NC} Error: git is required"
    exit 1
fi
echo "${GREEN}✓${NC} Found git"

# Clone or update repository
echo ""
if [ -d "$INSTALL_DIR" ]; then
    echo "${YELLOW}→${NC} Updating existing installation..."
    cd "$INSTALL_DIR"
    git pull origin main --quiet
else
    echo "${YELLOW}→${NC} Cloning Teleportation..."
    git clone --quiet "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# Install dependencies
echo "${YELLOW}→${NC} Installing dependencies..."
if [ "$RUNTIME" = "bun" ]; then
    bun install --silent
else
    npm install --silent
fi

# Create symlink for global access
echo "${YELLOW}→${NC} Setting up CLI..."
SYMLINK_PATH="/usr/local/bin/teleportation"

if [ -L "$SYMLINK_PATH" ] || [ -e "$SYMLINK_PATH" ]; then
    sudo rm -f "$SYMLINK_PATH"
fi

# Try to create symlink, fall back to alias suggestion
if sudo ln -sf "$INSTALL_DIR/teleportation-cli.cjs" "$SYMLINK_PATH" 2>/dev/null; then
    echo "${GREEN}✓${NC} Created symlink at $SYMLINK_PATH"
else
    echo "${YELLOW}!${NC} Could not create symlink. Add this to your shell profile:"
    echo ""
    echo "    alias teleportation='$INSTALL_DIR/teleportation-cli.cjs'"
    echo ""
fi

# Run setup
echo ""
echo "${CYAN}╭─────────────────────────────────────────────────────╮${NC}"
echo "${CYAN}│                                                     │${NC}"
echo "${CYAN}│   ${GREEN}✓ Installation complete!${CYAN}                          │${NC}"
echo "${CYAN}│                                                     │${NC}"
echo "${CYAN}╰─────────────────────────────────────────────────────╯${NC}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Run setup:     ${GREEN}teleportation setup${NC}"
echo "  2. Check status:  ${GREEN}teleportation status${NC}"
echo ""
echo "Or run directly:"
echo "  ${GREEN}$INSTALL_DIR/teleportation-cli.cjs setup${NC}"
echo ""
