/**
 * Synthetic key fixtures for the secrets canary (SPEC E-5).
 *
 * Keys are assembled from fragments at RUNTIME — no full key-shaped literal ever exists
 * in the repository, so GitHub push protection (and any other secret scanner) never
 * trips on the test suite. The assembled values are deterministic: identical on every
 * run, real provider formats, and distinct from upstream doc examples.
 */

const seed = 0x5eed1234;
let state = seed;
/** deterministic LCG — same "random" chars on every run */
function prng(): number {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0xffffffff;
}
const chars = (set: string, n: number): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += set[Math.floor(prng() * set.length)];
  return out;
};

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64ish = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ALNUM = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789";

export const FIXTURES = {
  // AWS docs example (upstream allowlisted): split so scanners don't fire on the source
  awsDocExample: ["AKIAIOSFODNN7", "EXAMPLE"].join(""),
  awsAccessKey: ["AKIA", chars(B32, 16)].join(""),
  githubPat: ["ghp_", chars(ALNUM, 36)].join(""),
  openaiKey: ["sk-proj-", chars(ALNUM, 74), "T3BlbkFJ", chars(ALNUM, 74)].join(""),
  slackBot: ["xoxb-", chars("0123456789", 10), "-", chars("0123456789", 13), "-", chars(ALNUM, 24)].join(""),
  dbUrl: ["postgres://svc_deploy:", chars(B64ish, 24), "@db-primary.internal:5432/billing"].join(""),
  jwt: ["eyJ", chars(B64ish, 20), ".ey", chars(B64ish, 20), ".", chars(B64ish, 20)].join(""),
  pemBlock: [
    "-----BEGIN RSA PRIVATE KEY-----\n",
    chars(B64ish, 68).replace(/(.{68})/, "$1"),
    "\n-----END RSA PRIVATE KEY-----",
  ].join(""),
} as const;
