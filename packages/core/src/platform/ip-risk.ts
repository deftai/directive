import { wordBoundaryMatch } from "./linear-scan.js";

export interface IPHit {
  readonly term: string;
  readonly category: string;
}

const BRANDED_GAMES_AND_UNIVERSES = [
  "Magic: The Gathering",
  "Magic the Gathering",
  "MTG",
  "Yu-Gi-Oh",
  "Yugioh",
  "Pokemon",
  "Pokémon",
  "Dungeons and Dragons",
  "Dungeons & Dragons",
  "D&D",
  "Warhammer",
  "Mario",
  "Zelda",
  "Final Fantasy",
  "Halo",
  "Call of Duty",
  "Fortnite",
  "Minecraft",
  "Roblox",
  "League of Legends",
  "World of Warcraft",
  "WoW",
  "Overwatch",
  "Counter-Strike",
  "Valorant",
  "Apex Legends",
  "Star Wars",
  "Star Trek",
  "Marvel",
  "DC Comics",
  "Harry Potter",
  "Lord of the Rings",
  "Middle-earth",
  "Game of Thrones",
  "Westeros",
  "Disney",
  "Pixar",
] as const;

const BRANDED_CHARACTERS = [
  "Mickey Mouse",
  "Spider-Man",
  "Spiderman",
  "Batman",
  "Superman",
  "Wonder Woman",
  "Iron Man",
  "Hulk",
  "Captain America",
  "Pikachu",
  "Sonic the Hedgehog",
  "Luigi",
  "Princess Peach",
  "Kirby",
  "Master Chief",
  "Lara Croft",
  "Indiana Jones",
  "James Bond",
] as const;

const SPORTS_LEAGUES = [
  "NFL",
  "NBA",
  "MLB",
  "NHL",
  "MLS",
  "FIFA",
  "UEFA",
  "Premier League",
  "La Liga",
  "Bundesliga",
  "Olympics",
  "Olympic Games",
  "Super Bowl",
  "World Cup",
] as const;

const BRANDED_PRODUCTS = [
  "iPhone",
  "iPad",
  "MacBook",
  "AirPods",
  "PlayStation",
  "Xbox",
  "Nintendo Switch",
  "Coca-Cola",
  "Pepsi",
  "Starbucks",
  "McDonald's",
  "Lego",
  "Barbie",
  "Hot Wheels",
] as const;

const MUSIC_AND_FILM = [
  "Taylor Swift",
  "Beyonce",
  "Beyoncé",
  "Spotify",
  "Netflix",
  "Hulu",
  "HBO",
] as const;

const FICTIONAL_UNIVERSE_TERMS = [
  "Hogwarts",
  "Jedi",
  "Sith",
  "Death Star",
  "Hobbit",
  "Vulcan",
  "Klingon",
  "Mandalorian",
  "Force-sensitive",
  "Muggle",
  "Quidditch",
  "Tatooine",
] as const;

const CATEGORIES: Record<string, readonly string[]> = {
  "branded-game-or-universe": BRANDED_GAMES_AND_UNIVERSES,
  "branded-character": BRANDED_CHARACTERS,
  "sports-league": SPORTS_LEAGUES,
  "branded-product": BRANDED_PRODUCTS,
  "music-or-film": MUSIC_AND_FILM,
  "fictional-universe-term": FICTIONAL_UNIVERSE_TERMS,
};

const VALID_INTENTS = new Set(["personal", "commercial", "unknown"]);

function validateIntent(intent: string): string {
  if (typeof intent !== "string") {
    throw new Error(`monetization_intent must be a string, got ${typeof intent}`);
  }
  const normalized = intent.trim().toLowerCase();
  if (!VALID_INTENTS.has(normalized)) {
    throw new Error(
      `monetization_intent ${JSON.stringify(intent)} not in ${[...VALID_INTENTS].sort()}`,
    );
  }
  return normalized;
}

/** Scan text for known IP terms (mirrors scripts/ip_risk.py). */
export function detectIpTerms(text: string): IPHit[] {
  if (!text) return [];
  const seen = new Set<string>();
  const hits: IPHit[] = [];
  for (const [category, terms] of Object.entries(CATEGORIES)) {
    for (let i = 0; i < text.length; i += 1) {
      for (const term of terms) {
        if (!wordBoundaryMatch(text, i, term)) continue;
        const actual = text.slice(i, i + term.length);
        const key = `${actual.toLowerCase()}\0${category}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ term: actual, category });
      }
    }
  }
  return hits;
}

export function isIpAdjacent(text: string): boolean {
  return detectIpTerms(text).length > 0;
}

export function ipRiskScopeItems(monetizationIntent: string): Array<Record<string, unknown>> {
  const intent = validateIntent(monetizationIntent);
  const commercial = intent !== "personal";

  const baseAcceptance = commercial
    ? "Lawyer-confirmed wording before public release"
    : "Reviewed by the project owner before any public release";
  const assetAcceptance = commercial
    ? "All third-party assets reach the app via official APIs only with a license that explicitly permits the planned use; no assets bundled in the repository or build artifacts; lawyer-confirmed before public release"
    : "All third-party assets reach the app via official APIs only; no assets bundled in the repository or build artifacts";
  const hostingAcceptance = commercial
    ? "Hosting plan reviewed by counsel; written license terms cover the deployment region and audience; revenue model documented"
    : "Self-hosted private use only; do not deploy publicly until a monetization decision is made and re-reviewed against this rule";

  return [
    {
      title: "IP-risk: disclaimer stub on the app's front surface",
      status: "pending",
      narrative: {
        Description:
          "Add a 'not affiliated with / not endorsed by' notice on the app's first user-visible surface (splash screen, landing page, or CLI banner).",
        Acceptance: baseAcceptance,
        Traces: "IP-1",
      },
    },
    {
      title: "IP-risk: API-only third-party asset access policy",
      status: "pending",
      narrative: {
        Description:
          "Never bundle third-party IP assets (images, audio, video, text, card data, character likenesses) in the repository or build artifacts. Access only via official APIs that grant a license.",
        Acceptance: assetAcceptance,
        Traces: "IP-2",
      },
    },
    {
      title: "IP-risk: hosting policy gated on monetization intent",
      status: "pending",
      narrative: {
        Description:
          "Document the hosting plan and gate it on the captured monetization intent. Self-hosted private use is the default; commercial hosting requires lawyer review.",
        Acceptance: hostingAcceptance,
        Traces: "IP-3",
      },
    },
  ];
}

export function plainRiskSummary(hits: IPHit[], monetizationIntent: string): string {
  if (hits.length === 0) return "";
  const intent = validateIntent(monetizationIntent);

  const grouped = new Map<string, string[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.category) ?? [];
    list.push(hit.term);
    grouped.set(hit.category, list);
  }

  const bullets: string[] = [];
  for (const [category, terms] of grouped) {
    const uniqueTerms = [...new Set(terms)].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    bullets.push(`- ${category}: ${uniqueTerms.join(", ")}`);
  }

  const header =
    "Heads up: your project description references third-party intellectual property (IP). This is a plain-English summary -- not legal advice.";
  const detectionBlock = `Detected IP-adjacent terms:\n${bullets.join("\n")}`;

  let intentBlock: string;
  if (intent === "commercial") {
    intentBlock =
      "You said you intend to use this commercially (sell access, earn revenue, distribute to paying users, or run ads). Commercial use of someone else's IP without a written license is the high-risk case. You MUST consult a lawyer before shipping to paying users -- this is not optional output from this interview.";
  } else if (intent === "personal") {
    intentBlock =
      "You said this is a personal project (no monetization, private use, learning). Personal use is lower risk but not zero risk: if your project ever goes public, becomes monetized, or is shared widely, the risk profile changes and a lawyer review becomes worthwhile.";
  } else {
    intentBlock =
      "You did not choose between personal and commercial use. The interview MUST capture an explicit answer before generating the SPECIFICATION -- the legal-risk profile depends on the answer.";
  }

  const nextSteps =
    "Suggested next steps: (1) confirm whether your use is personal or commercial; (2) keep the disclaimer / API-only-asset / hosting scope items the SPECIFICATION will include; (3) for commercial intent, consult a lawyer before public release.";

  return [header, detectionBlock, intentBlock, nextSteps].join("\n\n");
}
