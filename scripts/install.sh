#!/bin/bash
# Teleportation CLI Installation Script
# Installs Teleportation CLI from GitHub releases

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO="dundas/teleportation-private"
INSTALL_DIR="${HOME}/.teleportation"
BIN_DIR="${INSTALL_DIR}/bin"
CLI_NAME="teleportation"
LATEST_RELEASE_URL="https://api.github.com/repos/${REPO}/releases/latest"

# Functions
error() {
    echo -e "${RED}❌ Error:${NC} $1" >&2
    exit 1
}

info() {
    echo -e "${BLUE}ℹ️  ${NC}$1"
}

success() {
    echo -e "${GREEN}✅${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠️  ${NC}$1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    if ! command_exists curl; then
        error "curl is required but not installed. Please install curl and try again."
    fi
    
    if ! command_exists node; then
        error "Node.js is required but not installed. Please install Node.js 20+ and try again."
    fi
    
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "Node.js 20+ is required. Found: $(node -v). Please upgrade Node.js."
    fi
    
    success "Prerequisites check passed"
}

# Detect platform
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"
    
    case "$OS" in
        Linux*)
            PLATFORM="linux"
            ;;
        Darwin*)
            PLATFORM="darwin"
            ;;
        *)
            error "Unsupported operating system: $OS"
            ;;
    esac
    
    case "$ARCH" in
        x86_64)
            ARCH="x64"
            ;;
        arm64|aarch64)
            ARCH="arm64"
            ;;
        *)
            error "Unsupported architecture: $ARCH"
            ;;
    esac
    
    info "Detected platform: ${PLATFORM}-${ARCH}"
}

# Get latest release info
get_latest_release() {
    info "Fetching latest release information..."
    
    if [ -z "${GITHUB_TOKEN:-}" ]; then
        RELEASE_INFO=$(curl -s "$LATEST_RELEASE_URL" || error "Failed to fetch release information")
    else
        RELEASE_INFO=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "$LATEST_RELEASE_URL" || error "Failed to fetch release information")
    fi
    
    VERSION=$(echo "$RELEASE_INFO" | grep '"tag_name":' | sed -E 's/.*"tag_name": "([^"]+)".*/\1/' | sed 's/^v//')
    ASSET_NAME="teleportation-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
    
    if [ -z "$VERSION" ]; then
        error "Could not determine latest version. Repository may not have releases yet."
    fi
    
    info "Latest version: $VERSION"
}

# Download and extract release
download_release() {
    info "Downloading Teleportation CLI..."
    
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET_NAME}"
    TEMP_DIR=$(mktemp -d)
    TARBALL="${TEMP_DIR}/${ASSET_NAME}"
    
    # Download
    if ! curl -fsSL -o "$TARBALL" "$DOWNLOAD_URL"; then
        rm -rf "$TEMP_DIR"
        error "Failed to download release. URL: $DOWNLOAD_URL"
    fi
    
    success "Downloaded release"
    
    # Create install directory
    mkdir -p "$INSTALL_DIR" "$BIN_DIR"
    
    # Extract
    info "Extracting files..."
    tar -xzf "$TARBALL" -C "$INSTALL_DIR" || {
        rm -rf "$TEMP_DIR"
        error "Failed to extract release archive"
    }
    
    # Cleanup
    rm -rf "$TEMP_DIR"
    
    success "Extracted to $INSTALL_DIR"
}

# Install from source (fallback for development)
install_from_source() {
    info "Installing from source (development mode)..."
    
    # Get script directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    
    # Create install directory
    mkdir -p "$INSTALL_DIR" "$BIN_DIR"
    
    # Copy files
    cp -r "$PROJECT_DIR/lib" "$INSTALL_DIR/"
    cp -r "$PROJECT_DIR/.claude" "$INSTALL_DIR/" 2>/dev/null || true
    cp "$PROJECT_DIR/teleportation-cli.cjs" "$INSTALL_DIR/"
    cp "$PROJECT_DIR/package.json" "$INSTALL_DIR/" 2>/dev/null || true
    
    # Create symlink
    ln -sf "$INSTALL_DIR/teleportation-cli.cjs" "$BIN_DIR/$CLI_NAME"
    chmod +x "$BIN_DIR/$CLI_NAME"
    
    success "Installed from source"
}

# Set up PATH
setup_path() {
    info "Setting up PATH..."
    
    # Detect shell
    SHELL_NAME=$(basename "$SHELL")
    
    case "$SHELL_NAME" in
        bash)
            RC_FILE="${HOME}/.bashrc"
            ;;
        zsh)
            RC_FILE="${HOME}/.zshrc"
            ;;
        fish)
            RC_FILE="${HOME}/.config/fish/config.fish"
            ;;
        *)
            warning "Unknown shell: $SHELL_NAME. Please manually add $BIN_DIR to your PATH."
            return
            ;;
    esac
    
    # Check if already in PATH
    if echo "$PATH" | grep -q "$BIN_DIR"; then
        success "PATH already configured"
        return
    fi
    
    # Add to PATH
    if [ "$SHELL_NAME" = "fish" ]; then
        PATH_LINE="set -gx PATH \"$BIN_DIR\" \$PATH"
    else
        PATH_LINE="export PATH=\"\$PATH:$BIN_DIR\""
    fi
    
    if ! grep -q "$BIN_DIR" "$RC_FILE" 2>/dev/null; then
        echo "" >> "$RC_FILE"
        echo "# Teleportation CLI" >> "$RC_FILE"
        echo "$PATH_LINE" >> "$RC_FILE"
        success "Added $BIN_DIR to PATH in $RC_FILE"
        info "Run 'source $RC_FILE' or restart your terminal to use teleportation command"
    else
        success "PATH already configured in $RC_FILE"
    fi
}

# Verify installation
verify_installation() {
    info "Verifying installation..."
    
    if [ ! -f "$BIN_DIR/$CLI_NAME" ]; then
        error "CLI binary not found at $BIN_DIR/$CLI_NAME"
    fi
    
    if [ ! -x "$BIN_DIR/$CLI_NAME" ]; then
        error "CLI binary is not executable"
    fi
    
    success "Installation verified"
}

# Main installation
main() {
    echo -e "${BLUE}"
    echo "╔════════════════════════════════════════╗"
    echo "║   Teleportation CLI Installation       ║"
    echo "╚════════════════════════════════════════╝"
    echo -e "${NC}"
    
    check_prerequisites
    detect_platform
    
    # Try to download release, fallback to source install
    if get_latest_release 2>/dev/null; then
        download_release
    else
        warning "Could not fetch release. Installing from source..."
        install_from_source
    fi
    
    setup_path
    verify_installation
    
    echo ""
    success "Installation complete!"
    echo ""
    info "Next steps:"
    echo "  1. Run 'source ~/.${SHELL_NAME##*/}rc' or restart your terminal"
    echo "  2. Run 'teleportation on' to enable hooks"
    echo "  3. Run 'teleportation login' to authenticate"
    echo ""
    info "For more information, visit: https://github.com/${REPO}"
}

# Run main function
main "$@"

