# Content-aware pin unit for deposited deft-core-guard (#3193).
# Invoked as: python3 - "$BASE_SHA" "$HEAD_SHA"
# Mirrors packages/core/src/init-deposit/hygiene.ts isUpgradePinPathContentAllowed.
from __future__ import annotations

import json
import re
import subprocess
import sys

_Q = chr(39) + chr(34)  # ' and " without raw-string quote pain


def git_show(sha, path):
    try:
        return subprocess.check_output(
            ["git", "show", f"{sha}:{path}"], text=True, stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError:
        return ""


def changed_names(base_sha, head_sha):
    out = subprocess.check_output(
        ["git", "diff", "--name-only", base_sha, head_sha], text=True
    )
    return [p for p in out.splitlines() if p]


def is_dir_key(n):
    return n.startswith("@deftai/directive")


DEP_FIELDS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)


def deep_eq(a, b):
    if a is b:
        return True
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        if set(a) != set(b):
            return False
        return all(deep_eq(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(deep_eq(x, y) for x, y in zip(a, b))
    return a == b


def strip_pins(obj):
    if not isinstance(obj, dict):
        return obj
    out = {}
    for k, v in obj.items():
        if k in DEP_FIELDS and isinstance(v, dict):
            out[k] = {dk: dv for dk, dv in v.items() if not is_dir_key(dk)}
        else:
            out[k] = v
    return out


def pkg_pin_only(base, head):
    try:
        b, h = json.loads(base or "{}"), json.loads(head or "{}")
    except json.JSONDecodeError:
        return False
    return deep_eq(strip_pins(b), strip_pins(h))


def collect_deps(pkg):
    out = {}
    if not isinstance(pkg, dict):
        return out
    for f in DEP_FIELDS:
        block = pkg.get(f)
        if isinstance(block, dict):
            for k, v in block.items():
                if isinstance(v, str):
                    out[k] = v
                elif isinstance(v, dict) and isinstance(v.get("version"), str):
                    out[k] = v["version"]
                elif v is not None:
                    out[k] = str(v)
    return out


def only_dir_diff(bd, hd):
    keys = set(bd) | set(hd)
    for k in keys:
        if is_dir_key(k):
            continue
        if bd.get(k) != hd.get(k):
            return False
    return True


def npm_root_deps(lock):
    pkgs = lock.get("packages") if isinstance(lock, dict) else None
    if isinstance(pkgs, dict) and isinstance(pkgs.get(""), dict):
        return collect_deps(pkgs[""])
    deps = lock.get("dependencies") if isinstance(lock, dict) else None
    out = {}
    if isinstance(deps, dict):
        for k, v in deps.items():
            if isinstance(v, dict):
                out[k] = str(v.get("version", v))
            elif isinstance(v, str):
                out[k] = v
    return out


def npm_lock_ok(base, head):
    try:
        b, h = json.loads(base or "{}"), json.loads(head or "{}")
    except json.JSONDecodeError:
        return False
    br, hr = npm_root_deps(b), npm_root_deps(h)
    if not only_dir_diff(br, hr):
        return False
    bp, hp = b.get("packages") or {}, h.get("packages") or {}
    if not isinstance(bp, dict):
        bp = {}
    if not isinstance(hp, dict):
        hp = {}
    product = [k for k in set(br) | set(hr) if not is_dir_key(k)]
    for name in product:
        key = f"node_modules/{name}"
        if not deep_eq(bp.get(key), hp.get(key)):
            return False
    return True


def unq(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in _Q:
        return s[1:-1]
    return s


def pnpm_root_deps(raw):
    out = {}
    in_imp = in_root = in_dep = False
    cur = None
    for line in raw.splitlines():
        if re.match(r"^importers:\s*$", line):
            in_imp, in_root, in_dep, cur = True, False, False, None
            continue
        if not in_imp:
            continue
        if re.match(r"^[^\s#]", line) and not line.startswith("importers"):
            break
        if re.match(r"^ {2}(?:\.|'\.'|\"\.\"):\s*$", line):
            in_root, in_dep, cur = True, False, None
            continue
        if in_root and re.match(r"^ {2}\S", line) and not re.match(r"^ {2}\.", line):
            in_root, in_dep, cur = False, False, None
            continue
        if not in_root:
            continue
        if re.match(
            r"^ {4}(?:dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$",
            line,
        ):
            in_dep, cur = True, None
            continue
        if in_dep and re.match(r"^ {4}\S", line):
            in_dep, cur = False, None
            continue
        if not in_dep:
            continue
        m = re.match(r"^ {6}(.+?):\s*$", line)
        if m:
            cur = unq(m.group(1))
            continue
        if cur:
            vm = re.match(r"^ {8}version:\s*(.+?)\s*$", line)
            if vm:
                out[cur] = unq(vm.group(1))
                cur = None
    return out


def pnpm_ok(base, head):
    return only_dir_diff(pnpm_root_deps(base), pnpm_root_deps(head))


def yarn_blocks(raw):
    blocks = {}
    names, buf = [], []

    def flush():
        nonlocal names, buf
        if not names:
            return
        body = "\n".join(buf)
        for n in names:
            blocks[n] = body
        names, buf = [], []

    for line in raw.splitlines():
        if line == "" or line.startswith("#"):
            if names and line == "":
                flush()
            continue
        if not re.match(r"^\s", line) and line.endswith(":"):
            flush()
            header = line[:-1]
            names = []
            for part in header.split(","):
                p = part.strip()
                if len(p) >= 2 and p[0] == p[-1] and p[0] in _Q:
                    p = p[1:-1]
                at = p.find("@", 1) if p.startswith("@") else p.find("@")
                names.append(p[:at] if at > 0 else p)
            buf = [line]
            continue
        if names:
            buf.append(line)
    flush()
    return blocks


def yarn_ok(base, head):
    bb, hb = yarn_blocks(base), yarn_blocks(head)
    for name, body in bb.items():
        if is_dir_key(name):
            continue
        if name not in hb:
            return False
        if hb[name] != body:
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2:
        print("usage: core_guard_pin_content.py <base_sha> <head_sha>", file=sys.stderr)
        return 2
    base_sha, head_sha = args[0], args[1]
    paths = changed_names(base_sha, head_sha)
    core = [p for p in paths if p == ".deft/core" or p.startswith(".deft/core/")]
    if not core:
        return 0
    checks = {
        "package.json": pkg_pin_only,
        "package-lock.json": npm_lock_ok,
        "pnpm-lock.yaml": pnpm_ok,
        "yarn.lock": yarn_ok,
    }
    bad = []
    for path, fn in checks.items():
        if path not in paths:
            continue
        if not fn(git_show(base_sha, path), git_show(head_sha, path)):
            bad.append(path)
    if bad:
        print(
            "::error title=deft-core guard (#3193)::package/lock co-travel with "
            ".deft/core/** must be @deftai/directive* pin-only + lock follow-through. "
            "Rejected: " + ", ".join(bad)
        )
        print("--- content-rejected pin/lock paths ---")
        print("\n".join(bad))
        return 1
    print("OK: package/lock content is Directive pin unit (#3193).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
