"""Verify required toolchain is installed (go, uv, task, git, gh)."""

import subprocess
import sys

TOOLS = [
    ("go", ["go", "version"]),
    ("uv", ["uv", "--version"]),
    ("task", ["task", "--version"]),
    ("git", ["git", "--version"]),
    ("gh", ["gh", "--version"]),
]


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
        return 1
    print("All required tools available")
    return 0


if __name__ == "__main__":
    sys.exit(main())
