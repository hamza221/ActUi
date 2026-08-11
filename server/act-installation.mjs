export const ACT_INSTALLATION_DOCS = "https://nektosact.com/installation/index.html";

export function actInstallationFor(platform = process.platform, architecture = process.arch) {
  const common = {
    docsUrl: ACT_INSTALLATION_DOCS,
    architecture,
    verifyCommand: "act --version",
    mitigations: [
      "Restart ActUI after installation so the new executable is detected on PATH.",
      "If Act is already installed outside PATH, launch with --act-path /absolute/path/to/act.",
      "Docker is normally required for container jobs; self-hosted jobs can be mapped to run directly on the host.",
    ],
  };

  if (platform === "darwin") return {
    ...common, platform, os: "macOS", packageManager: "Homebrew",
    command: "brew install act", alternatives: ["sudo port install act"],
  };
  if (platform === "win32") return {
    ...common, platform, os: "Windows", packageManager: "WinGet",
    command: "winget install nektos.act", alternatives: ["choco install act-cli", "scoop install act"],
  };
  if (platform === "linux") return {
    ...common, platform, os: "Linux", packageManager: "official installer",
    command: "curl --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash",
    alternatives: ["brew install act"],
  };
  return {
    ...common, platform, os: platform || "this operating system", packageManager: "official installer",
    command: "curl --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash",
    alternatives: [],
  };
}
