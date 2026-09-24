/**
 * The vocabulary `DESIGN.md` → No model-side controls bars from anything the
 * model is told about how to act: the system prompt and every tool description.
 *
 * "Nothing about confirming, refusing, escalating, retrying, caution or
 * irreversibility", and the phrasings that carried those in drafts that were
 * caught: "there is no undo", "and only then", "tell the user … and stop",
 * "always before recording a decision", "use this only to …".
 *
 * The deployed tool descriptions are Python and are checked in Python, against
 * this same pattern: `tools/loan/tests/test_descriptions.py` and
 * `tools/approvals/tests/test_descriptions.py`. Change all three together.
 */
export const BEHAVIOURAL =
  /\b(escalat\w*|refus\w*|retr(?:y|ies|ying)|confirm\w*|caution\w*|irreversib\w*|undo|only then|and stop|wait for|always|use this only|you (?:should|must|do not|can))\b/i;
