import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import test from "node:test";

const shortName = ["w", "c"].join("");
const accessibilityName = [shortName, "ag"].join("");
const fullNamePattern = new RegExp(["work", "[\\s_-]*", "claw"].join(""), "i");
const tokenBoundary = "[^a-z0-9]";
const shortPrefixPattern = new RegExp([`(?:^|${tokenBoundary})`, "w", "c", "[-_]"].join(""), "i");
const exactShortPattern = new RegExp([`(?:^|${tokenBoundary})(`, "w", "c", `)(?=$|${tokenBoundary})`].join(""), "gi");
const binaryShortPattern = new RegExp(
  [`(?:^|${tokenBoundary})(`, "w", "c", `[a-z0-9]*)(?=$|${tokenBoundary})`].join(""),
  "gi",
);
const compactTextPattern = new RegExp(
  [`(?:^|${tokenBoundary})(`, "w", "c", `[a-z0-9]+)(?=$|${tokenBoundary})`].join(""),
  "gi",
);
const camelShortPattern = new RegExp(
  [
    "(?:",
    "W",
    "c",
    "(?=[A-Z0-9_-])|",
    "w",
    "c",
    "(?=[A-Z0-9_-])|",
    "W",
    "C",
    "(?!AG(?:[^a-z]|$))(?=[A-Za-z0-9_-]))",
  ].join(""),
  "g",
);

function isAccessibilityToken(token: string): boolean {
  const match = new RegExp(`^${accessibilityName}(\\d*)(.*)$`, "i").exec(token);
  if (!match) return false;
  return match[2] === "" || /^[A-Z]/.test(match[2] ?? "");
}

function findLegacyNames(
  text: string,
  options: { binary?: boolean; compressed?: boolean; path?: boolean } = {},
): string[] {
  const matches: string[] = [];
  const fullNameMatch = fullNamePattern.exec(text);
  if (fullNameMatch) {
    const lineNumber = text.slice(0, fullNameMatch.index).split(/\r?\n/).length;
    matches.push(`${lineNumber}:${fullNameMatch[0].replace(/\r?\n/g, "\\n")}`);
  }

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const searchableLine = line.replace(/(["']integrity["']\s*:\s*["'])[^"'\r\n]*(["'])/gi, "$1$2");

    camelShortPattern.lastIndex = 0;
    if (shortPrefixPattern.test(searchableLine) || camelShortPattern.test(searchableLine)) {
      matches.push(`${index + 1}:${line}`);
      continue;
    }

    if (options.binary) {
      binaryShortPattern.lastIndex = 0;
      const hasLegacyBinaryName = [...searchableLine.matchAll(binaryShortPattern)].some((match) => {
        const rawToken = match[1] ?? "";
        const token = rawToken.toLowerCase();
        if (isAccessibilityToken(rawToken)) return false;
        if (token !== shortName) return true;
        if (!options.compressed) return true;
        const tokenStart = (match.index ?? 0) + match[0].lastIndexOf(match[1] ?? "");
        const before = searchableLine[tokenStart - 1] ?? "";
        const after = searchableLine[tokenStart + token.length] ?? "";
        return [before, after].every((char) => char === "" || char.charCodeAt(0) <= 0x7f);
      });
      if (hasLegacyBinaryName) {
        matches.push(`${index + 1}:${line}`);
      }
      continue;
    }

    exactShortPattern.lastIndex = 0;
    const hasLegacyExactName = [...searchableLine.matchAll(exactShortPattern)].some((match) => {
      const token = match[1] ?? "";
      const tokenStart = (match.index ?? 0) + match[0].lastIndexOf(token);
      if (options.path) return true;
      const before = searchableLine.slice(0, tokenStart);
      const after = searchableLine.slice(tokenStart + token.length);
      if (before.endsWith("_") || after.startsWith("_")) return true;
      const atShellCommandStart =
        /(?:^|[|;&(])\s*$/.test(before) || /(?:^|\s)(?:then|do|else|if|while|until|!)\s+$/.test(before);
      const atEmbeddedCommandStart = /[`/"']\s*$/.test(before);
      const hasCommandTail =
        (atShellCommandStart && /^(?:\s+(?:--?[a-z]|["'./~$a-z0-9])|\s*[<>|&;])/i.test(after)) ||
        (atEmbeddedCommandStart && /^(?:\s+--?[a-z]|\s+(?:["'./~$]|[^\s]*[./][^\s]*)|\s*[<>|&;])/i.test(after));
      const readsPipedInput = after.trim() === "" && atShellCommandStart;
      return !hasCommandTail && !readsPipedInput;
    });
    if (hasLegacyExactName) {
      matches.push(`${index + 1}:${line}`);
      continue;
    }

    compactTextPattern.lastIndex = 0;
    for (const match of searchableLine.matchAll(compactTextPattern)) {
      if (isAccessibilityToken(match[1] ?? "")) continue;
      matches.push(`${index + 1}:${line}`);
      break;
    }
  }

  return matches;
}

function isBinary(content: Buffer): boolean {
  const sample = content.subarray(0, 8_000);
  if (sample.includes(0)) return true;
  const controls = sample.filter((byte) => byte < 7 || (byte > 14 && byte < 32));
  return controls.length > sample.length / 10;
}

function isCompressedMedia(content: Buffer): boolean {
  return (
    content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    content.subarray(0, 4).toString("ascii") === "GIF8" ||
    (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP")
  );
}

function readTrackedContent(path: string): Buffer | null {
  try {
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// The name this project carried before Deskmate. Assembled from fragments so this
// file does not trip its own scan.
const priorName = ["q", "m"].join("");
const priorNamePattern = new RegExp(priorName, "gi");

// Occurrences that look like the prior name but are not branding. Subresource
// integrity digests are base64 content hashes, so any two-letter sequence turns up in
// them by chance; everything else in the tree is ours and must be clean.
const priorNameAllowances = [/sha\d{3}-[A-Za-z0-9+/=]+/g];

function findPriorNames(text: string): string[] {
  const matches: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    let searchable = line;
    for (const allowance of priorNameAllowances) {
      searchable = searchable.replace(allowance, "");
    }
    priorNamePattern.lastIndex = 0;
    if (priorNamePattern.test(searchable)) {
      matches.push(`${index + 1}:${line}`);
    }
  }
  return matches;
}

// The git-backed listing reports tracked files only. The fallback approximates that by
// honoring .gitignore's directory and extension entries, so build artifacts git would
// never report — a __pycache__ .pyc with an absolute build path baked in, say — stay out
// of the brand scan.
function ignoredEntries(): { directories: Set<string>; suffixes: Set<string> } {
  const directories = new Set([".git", "node_modules", "dist", "build"]);
  const suffixes = new Set<string>();
  let text: string;
  try {
    text = readFileSync(".gitignore", "utf8");
  } catch {
    return { directories, suffixes };
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.endsWith("/")) directories.add(line.slice(0, -1).replace(/^\.?\//, ""));
    else if (/^\*\.[A-Za-z0-9]+$/.test(line)) suffixes.add(line.slice(1));
  }
  return { directories, suffixes };
}

const ignored = ignoredEntries();

function walkRepository(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (ignored.directories.has(entry.name) || ignored.directories.has(relative)) return [];
      return walkRepository(`${directory}/${entry.name}`, relative);
    }
    if ([...ignored.suffixes].some((suffix) => entry.name.endsWith(suffix))) return [];
    return [relative];
  });
}

// Prefers git, but stays usable before `git init` has been run.
function listTrackedPaths(): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return walkRepository(".");
  }
}

const provisionedInfrastructure = ["deploy/sandbox/fly.toml"];

// Redistributed third-party artifacts. Their bytes are not ours to brand, and a
// compressed archive will match any short pattern by chance.
const thirdPartyRoots: string[] = [];

function brandScope(): string[] {
  return listTrackedPaths()
    .filter((path) => !path.startsWith("deploy/layers/"))
    .filter((path) => !thirdPartyRoots.some((root) => path.startsWith(root)))
    .filter((path) => !provisionedInfrastructure.includes(path));
}

test("tracked files use only Deskmate branding", () => {
  const paths = brandScope();
  const legacyPaths = paths.filter((path) => findLegacyNames(path, { path: true }).length > 0);
  const legacyContent = paths.flatMap((path) => {
    const content = readTrackedContent(path);
    if (!content || isCompressedMedia(content)) return [];
    return findLegacyNames(content.toString("latin1"), {
      binary: isBinary(content),
      compressed: isCompressedMedia(content),
    }).map((match) => `${path}:${match}`);
  });

  assert.deepEqual([...legacyPaths, ...legacyContent], []);
});

test("tracked files carry no trace of the prior name", () => {
  const paths = brandScope();
  const legacyPaths = paths.filter((path) => findPriorNames(path).length > 0);
  const legacyContent = paths.flatMap((path) => {
    const content = readTrackedContent(path);
    if (!content || isCompressedMedia(content)) return [];
    return findPriorNames(content.toString("latin1")).map((match) => `${path}:${match}`);
  });

  assert.deepEqual([...legacyPaths, ...legacyContent], []);
});

test("prior-name guard recognizes its variants and spares the exceptions", () => {
  const forbidden = [
    priorName,
    priorName.toUpperCase(),
    [priorName, "-core"].join(""),
    [priorName, "-preview"].join(""),
    ["acme-", priorName].join(""),
    ["update-", priorName].join(""),
    [priorName.toUpperCase(), "_BASE_PORT"].join(""),
    ["Q", priorName.slice(1), "Config"].join(""),
    ["Q", priorName.slice(1), "Cluster"].join(""),
    [priorName, ".config.jsonc"].join(""),
    [priorName, ".example.com"].join(""),
    ["not", priorName, ".example.com"].join(""),
    ["dockview-theme-", priorName].join(""),
    [priorName, "bot"].join(""),
    ["You are ", priorName.toUpperCase()].join(""),
  ];
  const allowed = [
    `"integrity": "sha512-+CNAzxglkrpNf/kKywqQfk74QjtceuOE7${["Q", priorName.slice(1)].join("")}+AF8miRvPF/wmmK5+OJOgVh3AVTT3RP2mH3+FOaxlE5v72owk0A=="`,
    `"integrity": "sha512-3hu+tD8YzSLGuFYtPRb48vdhKMi0KQV5sn+uWr8+7dMEq/2G/dtLrdDinkLjqq5TIbIBjYJ4Ax/n3YiaW7${priorName.toUpperCase()}8A=="`,
  ];

  assert.ok(forbidden.every((value) => findPriorNames(value).length > 0));
  assert.deepEqual(
    allowed.filter((value) => findPriorNames(value).length > 0),
    [],
  );
});

test("brand guard recognizes legacy variants", () => {
  const forbidden = [
    ["Work", "Claw"].join(""),
    ["Work", "_", "Claw"].join(""),
    ["Work", "-", "Claw"].join(""),
    ["Work", "  ", "Claw"].join(""),
    ["Work", "\n", "Claw"].join(""),
    ["name: ", shortName].join(""),
    ["name: ", shortName, " config"].join(""),
    ["legacy ", shortName, " identifier"].join(""),
    ["brand = ", shortName, " value"].join(""),
    ['product name is "', shortName, ' classic"'].join(""),
    ["the ", shortName, " README"].join(""),
    ["`", shortName, "`"].join(""),
    [shortName, "prod"].join(""),
    [shortName, "agent"].join(""),
    ["prefix_", shortName, "prod_suffix"].join(""),
    ["prefix_", shortName.toUpperCase(), "PROD_suffix"].join(""),
    ["prefix_", shortName, "-prod_suffix"].join(""),
    ["prefix_", shortName, "_suffix"].join(""),
    ["PrefixW", shortName.slice(1), "ProdSuffix"].join(""),
    ["prefixW", shortName.slice(1), "Prod"].join(""),
    ["myW", shortName.slice(1), "Config"].join(""),
    ["my", shortName.toUpperCase(), "DEVConfig"].join(""),
    ["my", shortName, "Prod"].join(""),
    ["my", shortName.toUpperCase(), "devConfig"].join(""),
    ["myW", shortName.slice(1), "_Config"].join(""),
    ["myW", shortName.slice(1), "-Config"].join(""),
    ["myW", shortName.slice(1), "2Config"].join(""),
    ["my", shortName.toUpperCase(), "_DEV"].join(""),
    ["my", shortName.toUpperCase(), "-DEV"].join(""),
    ["my", shortName, "_Config"].join(""),
    ["my", shortName, "-Config"].join(""),
    [accessibilityName.toUpperCase(), "ent"].join(""),
    JSON.stringify({ name: [shortName, "prod"].join(""), integrity: "sha512-x" }),
  ];
  const binaryMetadata = [
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(["NAME=", shortName.toUpperCase(), "PROD"].join("")),
      Buffer.from([0]),
    ]),
    Buffer.concat([Buffer.from([0]), Buffer.from(shortName), Buffer.from([0])]),
    Buffer.concat([Buffer.from([0]), Buffer.from(["path=foo/", shortName, "prod.bin"].join("")), Buffer.from([0])]),
    Buffer.concat([Buffer.from([0]), Buffer.from(["(", shortName.toUpperCase(), "PROD)"].join("")), Buffer.from([0])]),
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(["meta=", shortName, 'prod;"integrity":x'].join("")),
      Buffer.from([0]),
    ]),
    Buffer.concat([Buffer.from([0]), Buffer.from(["name=W", shortName.slice(1), "Prod"].join("")), Buffer.from([0])]),
    Buffer.concat([Buffer.from([1]), Buffer.from([shortName, "prod"].join("")), Buffer.from([2])]),
    Buffer.concat([Buffer.from([1]), Buffer.from(shortName), Buffer.from([2])]),
    Buffer.concat([Buffer.from([0, 0x80]), Buffer.from(shortName), Buffer.from([0x81, 0])]),
    Buffer.concat([Buffer.from([0, 0xa0]), Buffer.from(shortName), Buffer.from([0xa0, 0])]),
  ];
  const compressedMetadata = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0]),
    Buffer.from(["name=myW", shortName.slice(1), "Config"].join("")),
    Buffer.from([0]),
  ]);

  assert.ok(forbidden.every((value) => findLegacyNames(value).length > 0));
  assert.ok(binaryMetadata.every(isBinary));
  assert.ok(binaryMetadata.every((value) => findLegacyNames(value.toString("latin1"), { binary: true }).length > 0));
  assert.ok(isCompressedMedia(compressedMetadata));
  assert.ok(
    findLegacyNames(compressedMetadata.toString("latin1"), {
      binary: true,
      compressed: true,
    }).length > 0,
  );
  assert.ok(findLegacyNames(["links/", shortName, "prod"].join(""), { path: true }).length > 0);
  assert.deepEqual(findLegacyNames([shortName, " -c"].join("")), []);
  assert.deepEqual(findLegacyNames([shortName, " README.md"].join("")), []);
  assert.deepEqual(findLegacyNames([shortName, " --bytes README.md"].join("")), []);
  assert.deepEqual(findLegacyNames(["echo | ", shortName].join("")), []);
  assert.deepEqual(findLegacyNames([shortName, " > counts.txt"].join("")), []);
  assert.deepEqual(findLegacyNames("WCAG"), []);
  assert.deepEqual(findLegacyNames("WCAG2"), []);
  assert.deepEqual(findLegacyNames("WCAGConfig"), []);
  assert.deepEqual(findLegacyNames("WCAGTheme"), []);
  assert.deepEqual(findLegacyNames("WCAG2Config"), []);
  assert.deepEqual(findLegacyNames("wcagConfig"), []);
  assert.deepEqual(findLegacyNames("myWCAGConfig"), []);
});
