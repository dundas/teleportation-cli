#!/bin/sh
# Teleportation Installer
# Usage: curl -fsSL https://get.teleportation.dev | bash

set -e

# Configuration - validated below
# Note: This install script points to the PUBLIC repository (teleportation-cli)
# Development happens in the PRIVATE repository (teleportation-private)
# Changes are synced from private → public for public distribution
# To use a different repo, set TELEPORTATION_REPO environment variable:
#   export TELEPORTATION_REPO="https://github.com/your-org/your-repo.git"
REPO="${TELEPORTATION_REPO:-https://github.com/dundas/teleportation-cli.git}"
INSTALL_DIR="$HOME/.teleportation-cli"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Validate configuration
if [ -z "$HOME" ]; then
    echo "${RED}Error: HOME environment variable is not set${NC}"
    exit 1
fi

# Validate REPO URL - only allow GitHub repositories for security
case "$REPO" in
    https://github.com/*|git@github.com:*)
        # Valid GitHub URL
        ;;
    *)
        echo "${RED}Error: Only GitHub repositories are supported${NC}"
        echo "${YELLOW}  Provided: ${REPO}${NC}"
        echo "${YELLOW}  Expected format: https://github.com/org/repo.git${NC}"
        exit 1
        ;;
esac

# Validate INSTALL_DIR doesn't contain dangerous characters
case "$INSTALL_DIR" in
    *[[:space:]]*)
        echo "${YELLOW}Warning: Install path contains spaces, this may cause issues${NC}"
        ;;
    *\$* | *\`* | *\\*)
        echo "${RED}Error: Install path contains invalid characters${NC}"
        exit 1
        ;;
esac

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
    if ! git pull origin main --quiet; then
        echo "${RED}✗${NC} Failed to pull latest changes"
        echo "${YELLOW}  Check your network connection and try again${NC}"
        exit 1
    fi
else
    echo "${YELLOW}→${NC} Cloning Teleportation..."
    if ! git clone --quiet "$REPO" "$INSTALL_DIR"; then
        echo "${RED}✗${NC} Failed to clone repository"
        echo "${YELLOW}  Check your network connection and try again${NC}"
        exit 1
    fi
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
USER_BIN_PATH="$HOME/.local/bin/teleportation"

# Try user-level install first (no sudo needed)
mkdir -p "$HOME/.local/bin" 2>/dev/null
if ln -sf "$INSTALL_DIR/teleportation-cli.cjs" "$USER_BIN_PATH" 2>/dev/null; then
    echo "${GREEN}✓${NC} Created symlink at $USER_BIN_PATH"
    
    # Check if ~/.local/bin is in PATH
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *)
            echo "${YELLOW}!${NC} Add ~/.local/bin to your PATH:"
            echo ""
            echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
            echo ""
            ;;
    esac
else
    # Fall back to system-level install (requires sudo)
    echo "${YELLOW}!${NC} User install failed. Trying system-level install..."
    echo "${YELLOW}   This may require your password for sudo.${NC}"
    echo ""
    
    if [ -L "$SYMLINK_PATH" ] || [ -e "$SYMLINK_PATH" ]; then
        sudo rm -f "$SYMLINK_PATH"
    fi
    
    if sudo ln -sf "$INSTALL_DIR/teleportation-cli.cjs" "$SYMLINK_PATH" 2>/dev/null; then
        echo "${GREEN}✓${NC} Created symlink at $SYMLINK_PATH"
    else
        echo "${YELLOW}!${NC} Could not create symlink. Add this to your shell profile:"
        echo ""
        echo "    alias teleportation='$INSTALL_DIR/teleportation-cli.cjs'"
        echo ""
    fi
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
