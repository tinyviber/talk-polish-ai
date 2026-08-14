const TITLE_MAX_CHARS = 24;
const TITLE_CONTENT_RE = /[\p{Script=Han}]|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;

export function deriveStableDailyStoryTitle(storyZh: string) {
  const clean = stripControls(storyZh).replace(/\s+/g, " ").trim();
  const firstClause = clean.split(/[，。！？；\n]/u, 1)[0]?.trim() || clean;
  if (firstClause.length >= 2) return firstClause.slice(0, TITLE_MAX_CHARS);
  return "今天的英语练习";
}

export function acceptGroundedDailyStoryTitle(
  storyZh: string,
  title: unknown,
  titleBasis: unknown,
) {
  if (typeof title !== "string" || typeof titleBasis !== "string") return null;
  const cleanTitle = stripControls(title).replace(/\s+/g, " ").trim();
  const basis = titleBasis.trim();
  if (cleanTitle.length < 2 || cleanTitle.length > TITLE_MAX_CHARS || !basis) return null;
  if (basis.length > 120 || !storyZh.includes(basis)) return null;
  if (/[\n\r<>]/u.test(cleanTitle)) return null;
  // A grounded basis alone is not enough: the model could still append a new
  // event, person, place, or number. Require every title content atom to be
  // an ordered atom from the original story. This is intentionally stricter
  // than semantic similarity; uncertain titles take the deterministic fallback.
  if (!isOrderedContentSubsequence(cleanTitle, storyZh)) return null;
  return cleanTitle;
}

function isOrderedContentSubsequence(title: string, storyZh: string) {
  const titleAtoms = contentAtoms(title);
  const storyAtoms = contentAtoms(storyZh);
  if (titleAtoms.length === 0 || storyAtoms.length === 0) return false;

  let storyIndex = 0;
  for (const titleAtom of titleAtoms) {
    const foundAt = storyAtoms.indexOf(titleAtom, storyIndex);
    if (foundAt < 0) return false;
    storyIndex = foundAt + 1;
  }
  return true;
}

function contentAtoms(value: string) {
  return [...value.normalize("NFKC").matchAll(TITLE_CONTENT_RE)].map((match) =>
    match[0]!.toLocaleLowerCase("en-US"),
  );
}

function stripControls(value: string) {
  return [...value].filter((character) => character.charCodeAt(0) >= 32).join("");
}
