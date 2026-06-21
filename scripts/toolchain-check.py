"""Verify required source-repo toolchain is installed (go, uv, git, gh, node, pnpm)."""

import subprocess
import sys

TOOLS = [
    ("go", ["go", "version"]),
    ("uv", ["uv", "--version"]),
    ("git", ["git", "--version"]),
    ("gh", ["gh", "--version"]),
    ("node", ["node", "--version"]),
    ("pnpm", ["pnpm", "--version"]),
]

NODE_RUNTIME_TOOLS = frozenset({"node", "pnpm"})
NODE_RUNTIME_REMEDIATION = (
    "Node.js and pnpm are required for TS-backed deft gates. Install Node 20+ "
    "(see .nvmrc), then run: corepack enable && corepack prepare pnpm@latest "
    "--activate. See UPGRADING.md § Node runtime."
)


def main() -> int:
    failed = []
    for name, cmd in TOOLS:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            version = (r.stdout or r.stderr).strip().split("\n")[0]
            if r.returncode == 0:
                print(f"  {name}: {version}")
            else:
                failed.append(name)
                print(f"  {name}: FAILED (exit {r.returncode})")
        except FileNotFoundError:
            failed.append(name)
            print(f"  {name}: NOT FOUND")
        except Exception as e:
            failed.append(name)
            print(f"  {name}: ERROR - {e}")

    print()
    if failed:
        print(f"Missing tools: {', '.join(failed)}")
        if any(name in NODE_RUNTIME_TOOLS for name in failed):
            print(NODE_RUNTIME_REMEDIATION)
        return 1
    print("All required tools available")
    return 0


if __name__ == "__main__":
    sys.exit(main())
