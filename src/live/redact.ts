/**
 * Secret removal for every channel that leaves this process.
 *
 * There are three of them and they are easy to think of as one: the tool result
 * the model reads, the error text inside it, and the diagnostics written to the
 * MCP host's log. The log is the one that gets forgotten, and it is the worst of
 * the three — a tool result is transient, whereas a host log is a file on disk
 * that outlives the session. `CLAUDE.md` names logs explicitly for that reason.
 *
 * Two kinds of secret pass through here: the credentials in the environment, and
 * the session tokens, cookies and GWT nonce the live clients hold, which are
 * passed in by value because only the clients know them.
 */

const SECRET_VARIABLES = ['CRONOMETER_USERNAME', 'CRONOMETER_PASSWORD', 'CRONOMETER_TOTP_SECRET'] as const;

/**
 * A secret does not always come back in the form it was sent. It can arrive
 * JSON-escaped inside a response body or percent-encoded inside a URL, and a
 * plain substring match misses both.
 */
export function secretForms(secret: string): readonly string[] {
  if (secret === '') return [];
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
    // A lone surrogate cannot be percent-encoded; the plain form still applies.
  }
  // Longest first, so a short secret that is a substring of a longer encoding
  // cannot blank out part of it and leave the remainder readable.
  return [...forms].sort((a, b) => b.length - a.length);
}

export function redactSecrets(
  text: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  let safe = text;
  for (const name of SECRET_VARIABLES) {
    const secret = environment[name];
    if (secret === undefined || secret === '') continue;
    for (const form of secretForms(secret)) {
      safe = safe.split(form).join('[redacted]');
    }
  }
  return safe;
}

/** Removes each given secret value, in every form it may take. */
export function redactValues(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    for (const form of secretForms(secret)) safe = safe.split(form).join('[redacted]');
  }
  return safe;
}
