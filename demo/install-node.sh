#!/usr/bin/env sh
# Installs Node.js 22 LTS for the Vault demo (macOS / Linux). Run: ./install-node.sh
NODE_VERSION=22.16.0

if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v//; s/\..*//')
  if [ "$major" -ge 20 ]; then echo "Node.js $(node -v) is already installed. Run ./start-demo.sh"; exit 0; fi
  echo "Node.js $(node -v) is installed but the demo needs 20 or newer. Upgrading..."
fi

os=$(uname -s)
if [ "$os" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js 22 with Homebrew..."
    brew install node@22 && brew link --overwrite --force node@22 && echo "Done. Open a new terminal and run ./start-demo.sh" && exit 0
    echo "Homebrew did not finish; falling back to the installer from nodejs.org."
  fi
  pkg="/tmp/node-v$NODE_VERSION.pkg"
  echo "Downloading Node.js v$NODE_VERSION from nodejs.org..."
  curl -fL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.pkg" -o "$pkg" || { echo "Download failed. Install it from https://nodejs.org/"; exit 1; }
  echo "Running the installer (asks for your password)..."
  sudo installer -pkg "$pkg" -target / && echo "Done. Open a new terminal and run ./start-demo.sh" && exit 0
  echo "The installer failed. Install it from https://nodejs.org/"; exit 1
fi

# Linux: use the distribution's package manager via NodeSource when available, otherwise nvm in the home folder.
if command -v apt-get >/dev/null 2>&1; then
  echo "Installing Node.js 22 with apt (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs && echo "Done. Run ./start-demo.sh" && exit 0
elif command -v dnf >/dev/null 2>&1; then
  echo "Installing Node.js 22 with dnf (NodeSource)..."
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs && echo "Done. Run ./start-demo.sh" && exit 0
elif command -v pacman >/dev/null 2>&1; then
  echo "Installing Node.js with pacman..."
  sudo pacman -S --noconfirm nodejs npm && echo "Done. Run ./start-demo.sh" && exit 0
fi

echo "Installing Node.js 22 with nvm in your home folder (no root needed)..."
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash || { echo "nvm install failed. Install Node.js from https://nodejs.org/"; exit 1; }
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm alias default 22 && echo "Done. Open a new terminal and run ./start-demo.sh" && exit 0
echo "nvm could not install Node.js. Install it from https://nodejs.org/"; exit 1
