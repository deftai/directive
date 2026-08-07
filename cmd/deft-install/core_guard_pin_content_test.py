"""Unit tests for core_guard_pin_content.py (#3193 forward coverage)."""

from __future__ import annotations

import json
import unittest

from core_guard_pin_content import (
    is_dir_key,
    npm_lock_ok,
    pkg_pin_only,
    pnpm_ok,
    yarn_ok,
)


class TestDirectiveKey(unittest.TestCase):
    def test_directive_keys(self) -> None:
        self.assertTrue(is_dir_key("@deftai/directive"))
        self.assertTrue(is_dir_key("@deftai/directive-content"))
        self.assertFalse(is_dir_key("lodash"))
        self.assertFalse(is_dir_key("@types/node"))


class TestPackageJsonPinOnly(unittest.TestCase):
    def setUp(self) -> None:
        self.base = json.dumps(
            {
                "name": "app",
                "scripts": {"build": "tsc", "note": "npx @deftai/directive doctor"},
                "dependencies": {"lodash": "^4.17.21"},
                "devDependencies": {"@deftai/directive": "0.96.0", "typescript": "^5"},
            }
        )
        self.pin = json.dumps(
            {
                "name": "app",
                "scripts": {"build": "tsc", "note": "npx @deftai/directive doctor"},
                "dependencies": {"lodash": "^4.17.21"},
                "devDependencies": {"@deftai/directive": "0.97.0", "typescript": "^5"},
            }
        )
        self.script_change = json.dumps(
            {
                "name": "app",
                "scripts": {"build": "tsc && lint", "note": "npx @deftai/directive doctor"},
                "dependencies": {"lodash": "^4.17.21"},
                "devDependencies": {"@deftai/directive": "0.97.0", "typescript": "^5"},
            }
        )

    def test_pin_only_passes(self) -> None:
        self.assertTrue(pkg_pin_only(self.base, self.pin))

    def test_script_change_fails(self) -> None:
        self.assertFalse(pkg_pin_only(self.base, self.script_change))


class TestNpmLock(unittest.TestCase):
    def test_pin_follow_through_passes(self) -> None:
        base = json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "dependencies": {"lodash": "^4.17.21"},
                        "devDependencies": {"@deftai/directive": "0.96.0"},
                    },
                    "node_modules/lodash": {"version": "4.17.21"},
                    "node_modules/@deftai/directive": {"version": "0.96.0"},
                },
            }
        )
        head = json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "dependencies": {"lodash": "^4.17.21"},
                        "devDependencies": {"@deftai/directive": "0.97.0"},
                    },
                    "node_modules/lodash": {"version": "4.17.21"},
                    "node_modules/@deftai/directive": {"version": "0.97.0"},
                    "node_modules/some-transitive": {"version": "2.0.0"},
                },
            }
        )
        self.assertTrue(npm_lock_ok(base, head))

    def test_mixed_product_dep_fails(self) -> None:
        base = json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "dependencies": {"lodash": "^4.17.21"},
                        "devDependencies": {"@deftai/directive": "0.96.0"},
                    },
                    "node_modules/lodash": {"version": "4.17.21"},
                },
            }
        )
        head = json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "dependencies": {"lodash": "^4.18.0"},
                        "devDependencies": {"@deftai/directive": "0.97.0"},
                    },
                    "node_modules/lodash": {"version": "4.18.0"},
                },
            }
        )
        self.assertFalse(npm_lock_ok(base, head))


class TestPnpmLock(unittest.TestCase):
    def test_pin_follow_through_passes(self) -> None:
        base = "\n".join(
            [
                "lockfileVersion: '9.0'",
                "",
                "importers:",
                "",
                "  .:",
                "    dependencies:",
                "      lodash:",
                "        specifier: ^4.17.21",
                "        version: 4.17.21",
                "    devDependencies:",
                "      '@deftai/directive':",
                "        specifier: 0.96.0",
                "        version: 0.96.0",
                "",
                "packages:",
                "",
            ]
        )
        head = "\n".join(
            [
                "lockfileVersion: '9.0'",
                "",
                "importers:",
                "",
                "  .:",
                "    dependencies:",
                "      lodash:",
                "        specifier: ^4.17.21",
                "        version: 4.17.21",
                "    devDependencies:",
                "      '@deftai/directive':",
                "        specifier: 0.97.0",
                "        version: 0.97.0",
                "",
                "packages:",
                "",
            ]
        )
        self.assertTrue(pnpm_ok(base, head))


class TestYarnLock(unittest.TestCase):
    def test_pin_follow_through_and_mixed(self) -> None:
        base = "\n".join(
            [
                "# yarn lockfile v1",
                "",
                '"@deftai/directive@0.96.0":',
                '  version "0.96.0"',
                "",
                "lodash@^4.17.21:",
                '  version "4.17.21"',
                "",
            ]
        )
        pin = "\n".join(
            [
                "# yarn lockfile v1",
                "",
                '"@deftai/directive@0.97.0":',
                '  version "0.97.0"',
                "",
                "lodash@^4.17.21:",
                '  version "4.17.21"',
                "",
                "internal-util@1.0.0:",
                '  version "1.0.0"',
                "",
            ]
        )
        mixed = "\n".join(
            [
                "# yarn lockfile v1",
                "",
                '"@deftai/directive@0.97.0":',
                '  version "0.97.0"',
                "",
                "lodash@^4.17.21:",
                '  version "4.18.0"',
                "",
            ]
        )
        self.assertTrue(yarn_ok(base, pin))
        self.assertFalse(yarn_ok(base, mixed))


if __name__ == "__main__":
    unittest.main()
