section: Fixed
- When Directive's runtime pin is missing, the host-hook outer now allows the exact project install it already names (`pnpm install --frozen-lockfile`, `npm install`, or `npm ci`) through a shell tool at the project root, and keeps blocking every other command. The deny text names that exception. Global launcher repair stays out of this path (#7275).
